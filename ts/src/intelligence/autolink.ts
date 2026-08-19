/**
 * Auto-linking intelligence — proposes relationship edges between existing
 * memories, with explicit confidence and per-edge evidence.
 *
 * Implements the rules requested in issue #26 (auto-linking opt-in for
 * the memorygraph CLI). Each proposal carries an `Evidence` block so the
 * dry-run report and the apply log are auditable downstream. REPLACES is
 * never auto-created (gate lives in #31); TOUCHED is not in the enum
 * (covered by OCCURS_IN until #31 revisits).
 */

import type { Memory, RelationshipType } from "../models.js";
import { createRelationshipProperties } from "../models.js";
import type { IMemoryDatabase } from "../database.js";

export const STOPWORDS_PT: readonly string[] = [
  "de",
  "da",
  "do",
  "em",
  "para",
  "com",
  "por",
  "sem",
  "sob",
  "que",
  "não",
  "sim",
  "no",
  "na",
  "nos",
  "nas",
  "ao",
  "à",
  "aos",
  "às",
  "pelo",
  "pela",
  "pelos",
  "pelas",
  "este",
  "esta",
  "isto",
  "esse",
  "essa",
  "isso",
  "aquele",
  "aquela",
  "aquilo",
  "já",
  "ainda",
  "também",
  "só",
  "muito",
  "mais",
  "menos",
  "mesmo",
  "mesma",
  "ser",
  "estar",
  "ter",
  "haver",
  "fazer",
  "ir",
  "vir",
  "ver",
  "dar",
  "saber",
  "querer",
  "poder",
  "dizer",
  "ficar",
  "como",
  "quando",
  "onde",
  "porque",
  "embora",
  "então",
  "logo",
  "pois",
  "contudo",
  "porém",
  "todavia",
  "entretanto",
  "enfim",
  "portanto",
  "visto",
  "como",
  "a",
  "e",
  "ou",
  "é",
  "um",
  "uma",
  "uns",
  "umas",
  "os",
  "as",
  "dos",
  "das",
];

export const STOPWORDS_EN: readonly string[] = [
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "should",
  "could",
  "may",
  "might",
  "must",
  "shall",
  "can",
  "this",
  "that",
  "these",
  "those",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "where",
  "when",
  "why",
  "how",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "now",
  "here",
  "there",
  "then",
  "once",
  "if",
  "because",
  "while",
  "about",
  "into",
  "over",
  "after",
  "before",
  "between",
  "through",
  "during",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "a",
  "an",
];

export const MIN_TOKEN_LENGTH = 4;

export const STOPWORDS_ALL: ReadonlySet<string> = new Set([
  ...STOPWORDS_PT,
  ...STOPWORDS_EN,
]);

export type Evidence = {
  rule: string;
  matchedPattern: string;
  ruleReason: string;
  regex?: string;
  sharedTerms?: string[];
  nodeIds: { from: string; to: string };
};

export type ProposedEdge = {
  from: string;
  to: string;
  type: RelationshipType;
  confidence: number;
  timestamp: string;
  evidence: Evidence;
};

export type AutoLinkOptions = {
  minConfidence: number;
  allowTypes?: Set<RelationshipType>;
  excludeRules?: Set<string>;
};

export const DEFAULT_ALLOW_TYPES: ReadonlySet<RelationshipType> = new Set<RelationshipType>([
  "CAUSES",
  "CONFIRMS",
  "IMPROVES",
  "OCCURS_IN",
]);

export const REJECT_THRESHOLD = 0.5;

export type ProposeResult = {
  accept: ProposedEdge[];
  review: ProposedEdge[];
  rejected: ProposedEdge[];
};

export function tokenizeTitle(title: string): string[] {
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH)
    .filter((t) => !STOPWORDS_ALL.has(t));
  return tokens;
}

function sharedTokens(a: string[], b: string[]): string[] {
  const setA = new Set(a);
  const out: string[] = [];
  for (const t of b) {
    if (setA.has(t)) out.push(t);
  }
  return Array.from(new Set(out));
}

function tagsOverlap(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  return b.some((t) => setA.has(t));
}

function bucket(
  edges: ProposedEdge[],
  minConfidence: number,
): ProposeResult {
  const accept: ProposedEdge[] = [];
  const review: ProposedEdge[] = [];
  const rejected: ProposedEdge[] = [];
  for (const e of edges) {
    if (e.confidence < REJECT_THRESHOLD) {
      rejected.push(e);
    } else if (e.confidence >= minConfidence) {
      accept.push(e);
    } else {
      review.push(e);
    }
  }
  return { accept, review, rejected };
}

type Rule = {
  name: string;
  apply: (a: Memory, b: Memory) => ProposedEdge | null;
};

const RULES: Rule[] = [
  {
    name: "confirms-same-topic",
    apply: (a, b) => {
      if (a.type !== "solution" || b.type !== "solution") return null;
      if (a.id === b.id) return null;
      if (!tagsOverlap(a.tags, b.tags)) return null;
      const tokensA = tokenizeTitle(a.title);
      const tokensB = tokenizeTitle(b.title);
      const shared = sharedTokens(tokensA, tokensB);
      if (shared.length < 2) return null;
      const confidence = 0.6;
      const aId = a.id ?? "";
      const bId = b.id ?? "";
      const [from, to] = aId < bId ? [a, b] : [b, a];
      return {
        from: from.id ?? "",
        to: to.id ?? "",
        type: "CONFIRMS",
        timestamp: new Date().toISOString(),
        confidence,
        evidence: {
          rule: "confirms-same-topic",
          matchedPattern: `shared >= 4-char tokens: ${shared.join(", ")}`,
          ruleReason:
            `Both memories are solutions on overlapping tags with ${shared.length} ` +
            `qualifying shared terms (>= ${MIN_TOKEN_LENGTH} chars, stopword-filtered).`,
          sharedTerms: shared,
          nodeIds: { from: from.id ?? "", to: to.id ?? "" },
        },
      };
    },
  },
  {
    name: "causes-err-leads-to-dec",
    apply: (a, b) => {
      const err = a.type === "error" ? a : b.type === "error" ? b : null;
      const dec = a.type === "solution" ? a : b.type === "solution" ? b : null;
      if (!err || !dec || err.id === dec.id) return null;
      const errRegex = /\b(?:ERR|FIX)-\d+\b/g;
      const errIds = err.title.match(errRegex) ?? [];
      if (errIds.length === 0) return null;
      if (!tagsOverlap(err.tags, dec.tags)) return null;
      const matched = errIds.find((id) => dec.title.includes(id));
      if (!matched) return null;
      const confidence = 0.7;
      return {
        from: err.id ?? "",
        to: dec.id ?? "",
        type: "CAUSES",
        timestamp: new Date().toISOString(),
        confidence,
        evidence: {
          rule: "causes-err-leads-to-dec",
          matchedPattern: `regex ${errRegex.source} matched "${matched}" in DEC title`,
          regex: errRegex.source,
          ruleReason:
            `Error node references an ERR/FIX id that the DEC title cites via the same id.`,
          nodeIds: { from: err.id ?? "", to: dec.id ?? "" },
        },
      };
    },
  },
  {
    name: "improves-new-over-old",
    apply: (a, b) => {
      if (a.type !== "solution" || b.type !== "solution") return null;
      if (a.id === b.id) return null;
      if (!tagsOverlap(a.tags, b.tags)) return null;
      const aTime = Date.parse(String(a.created_at));
      const bTime = Date.parse(String(b.created_at));
      if (Number.isNaN(aTime) || Number.isNaN(bTime)) return null;
      let newer: Memory;
      let older: Memory;
      if (aTime > bTime && a.importance > b.importance) {
        newer = a;
        older = b;
      } else if (bTime > aTime && b.importance > a.importance) {
        newer = b;
        older = a;
      } else {
        return null;
      }
      const sharedTitle = sharedTokens(
        tokenizeTitle(newer.title),
        tokenizeTitle(older.title),
      );
      if (sharedTitle.length < 1) return null;
      const importanceDelta = newer.importance - older.importance;
      if (importanceDelta < 0.05) return null;
      const confidence = 0.5;
      return {
        from: newer.id ?? "",
        to: older.id ?? "",
        type: "IMPROVES",
        timestamp: new Date().toISOString(),
        confidence,
        evidence: {
          rule: "improves-new-over-old",
          matchedPattern: `newer=${newer.id} (importance=${newer.importance}) over older=${older.id} (importance=${older.importance})`,
          ruleReason:
            `Newer solution has strictly higher importance (+${importanceDelta.toFixed(2)}) ` +
            `and shares ${sharedTitle.length} qualifying title term(s) with the older solution on overlapping tags.`,
          nodeIds: { from: newer.id ?? "", to: older.id ?? "" },
        },
      };
    },
  },
  {
    name: "occurs-in-session-to-dec",
    apply: (a, b) => {
      const session = a.type === "conversation" ? a : b.type === "conversation" ? b : null;
      const target = a.type !== "conversation" ? a : b.type !== "conversation" ? b : null;
      if (!session || !target || session.id === target.id) return null;
      if (target.type !== "solution" && target.type !== "error") return null;
      const idRegex = /\b(?:DEC|ERR)-\d+\b/g;
      const refIds = session.title.match(idRegex) ?? [];
      const matched = refIds.find((id) => target.title.includes(id));
      if (!matched) return null;
      const confidence = 0.8;
      return {
        from: session.id ?? "",
        to: target.id ?? "",
        type: "OCCURS_IN",
        timestamp: new Date().toISOString(),
        confidence,
        evidence: {
          rule: "occurs-in-session-to-dec",
          matchedPattern: `regex ${idRegex.source} matched "${matched}" in session title`,
          regex: idRegex.source,
          ruleReason:
            `Conversation session references the DEC/ERR id in its title; ` +
            `session logically occurred in the context of that decision.`,
          nodeIds: { from: session.id ?? "", to: target.id ?? "" },
        },
      };
    },
  },
];

export function proposeEdges(memories: Memory[], opts: AutoLinkOptions): ProposeResult {
  const allowTypes = opts.allowTypes ?? DEFAULT_ALLOW_TYPES;
  const excludeRules = opts.excludeRules ?? new Set<string>();
  const proposals: ProposedEdge[] = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i]!;
      const b = memories[j]!;
      for (const rule of RULES) {
        if (excludeRules.has(rule.name)) continue;
        const edge = rule.apply(a, b);
        if (!edge) continue;
        if (!allowTypes.has(edge.type)) continue;
        proposals.push(edge);
      }
    }
  }
  return bucket(proposals, opts.minConfidence);
}

export type LinkResult = {
  created: boolean;
  skipped: string | null;
  error: string | null;
};

export async function linkIfMissing(
  db: IMemoryDatabase,
  edge: ProposedEdge,
): Promise<LinkResult> {
  let source: Memory | null;
  try {
    source = await db.getMemory(edge.from, true);
  } catch (err) {
    return {
      created: false,
      skipped: null,
      error: `source memory lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!source) {
    return {
      created: false,
      skipped: null,
      error: `source memory not found: ${edge.from}`,
    };
  }
  const directRelationships = source.relationships ?? {};
  const existing = directRelationships[edge.type] ?? [];
  if (existing.includes(edge.to)) {
    return { created: false, skipped: "duplicate", error: null };
  }
  try {
    const props = createRelationshipProperties({
      strength: Math.max(0.5, edge.confidence),
      confidence: edge.confidence,
      context: `[auto-link:${edge.evidence.rule}] ${edge.evidence.ruleReason}`,
    });
    await db.createRelationship(edge.from, edge.to, edge.type, props);
    return { created: true, skipped: null, error: null };
  } catch (err) {
    return {
      created: false,
      skipped: null,
      error: `createRelationship failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

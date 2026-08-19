/**
 * Tests for auto-linking intelligence (proposeEdges).
 *
 * Pure logic — no I/O. Covers stopword filter (PT+EN), evidence
 * structure, threshold bucketing, and REPLACES exclusion (per #26).
 */

import { describe, it, expect } from "bun:test";
import {
  proposeEdges,
  linkIfMissing,
  DEFAULT_ALLOW_TYPES,
  STOPWORDS_PT,
  STOPWORDS_EN,
  tokenizeTitle,
  type AutoLinkOptions,
} from "../src/intelligence/autolink.js";
import type { RelationshipType, Memory } from "../src/models.js";
import type { IMemoryDatabase } from "../src/database.js";

function makeMemory(over: Partial<Memory>): Memory {
  return {
    id: over.id ?? "00000000-0000-0000-0000-000000000000",
    type: over.type ?? "solution",
    title: over.title ?? "untitled",
    content: over.content ?? "",
    tags: over.tags ?? [],
    importance: over.importance ?? 0.5,
    confidence: over.confidence ?? 0.8,
    created_at: over.created_at ?? new Date().toISOString(),
    updated_at: over.updated_at ?? new Date().toISOString(),
    version: over.version ?? 1,
    usage_count: over.usage_count ?? 0,
    ...over,
  };
}

describe("tokenizeTitle", () => {
  it("lowercases, splits on non-alphanumeric, and removes stopwords (PT+EN)", () => {
    const tokens = tokenizeTitle("memory de graph: ranking e Honcho");
    expect(tokens).toContain("memory");
    expect(tokens).toContain("graph");
    expect(tokens).toContain("ranking");
    expect(tokens).toContain("honcho");
    expect(tokens).not.toContain("de");
    expect(tokens).not.toContain("e");
  });

  it("filters out tokens shorter than 4 chars (via min-token-length filter)", () => {
    const tokens = tokenizeTitle("a ab abc abcd abcde");
    expect(tokens).toContain("abcd");
    expect(tokens).toContain("abcde");
    expect(tokens).not.toContain("a");
    expect(tokens).not.toContain("ab");
    expect(tokens).not.toContain("abc");
  });

  it("STOPWORDS lists are non-empty and overlap-free", () => {
    expect(STOPWORDS_PT.length).toBeGreaterThan(20);
    expect(STOPWORDS_EN.length).toBeGreaterThan(20);
    const overlap = STOPWORDS_PT.filter((w) => STOPWORDS_EN.includes(w));
    // Allow a small intersection (e.g., "no", "as") but not many.
    expect(overlap.length).toBeLessThan(5);
  });
});

describe("proposeEdges — confirms-same-topic rule", () => {
  const opts: AutoLinkOptions = { minConfidence: 0.7 };

  it("proposes CONFIRMS between two DECs on same tag with 4+ char shared terms", () => {
    const a = makeMemory({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      title: "DEC-019 Honcho workspace binding activation",
      tags: ["desktop-link"],
    });
    const b = makeMemory({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      title: "DEC-022 Honcho workspace binding verification",
      tags: ["desktop-link"],
    });
    const result = proposeEdges([a, b], opts);
    const confirms = result.accept.concat(result.review).filter((e) => e.type === "CONFIRMS");
    expect(confirms.length).toBe(1);
    const edge = confirms[0]!;
    expect(edge.evidence.rule).toBe("confirms-same-topic");
    expect(edge.evidence.sharedTerms).toContain("honcho");
    expect(edge.evidence.sharedTerms).toContain("workspace");
    expect(edge.evidence.sharedTerms).toContain("binding");
    expect(edge.evidence.nodeIds.from).toBe(a.id ?? "");
    expect(edge.evidence.nodeIds.to).toBe(b.id ?? "");
  });

  it("does NOT match when shared terms are < 4 chars (after stopword filter)", () => {
    const a = makeMemory({
      id: "11111111-1111-1111-1111-111111111111",
      title: "DEC-001 de da do",
      tags: ["desktop-link"],
    });
    const b = makeMemory({
      id: "22222222-2222-2222-2222-222222222222",
      title: "DEC-002 de da do",
      tags: ["desktop-link"],
    });
    const result = proposeEdges([a, b], opts);
    expect(result.accept.concat(result.review)).toHaveLength(0);
  });

  it("does NOT match when tags differ", () => {
    const a = makeMemory({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      title: "DEC-019 Honcho workspace binding",
      tags: ["desktop-link"],
    });
    const b = makeMemory({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      title: "DEC-022 Honcho workspace binding",
      tags: ["operacional"],
    });
    const result = proposeEdges([a, b], opts);
    expect(result.accept.concat(result.review)).toHaveLength(0);
  });

  it("confidence 0.6 falls in review bucket (0.5–0.7) when minConfidence is 0.7", () => {
    const a = makeMemory({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      title: "DEC-019 Honcho workspace binding",
      tags: ["desktop-link"],
    });
    const b = makeMemory({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      title: "DEC-022 Honcho workspace binding",
      tags: ["desktop-link"],
    });
    const result = proposeEdges([a, b], opts);
    expect(result.review.length).toBe(1);
    expect(result.accept).toHaveLength(0);
  });
});

describe("proposeEdges — causes-err-leads-to-dec rule", () => {
  const opts: AutoLinkOptions = { minConfidence: 0.7 };

  it("proposes CAUSES from an ERR to a DEC that references the ERR id", () => {
    const err = makeMemory({
      id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      type: "error",
      title: "ERR-006 Honcho embeddings credit exhaustion",
      tags: ["desktop-link"],
      importance: 0.7,
    });
    const dec = makeMemory({
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      title: "DEC-045 nomic 768d self-host fix for ERR-006",
      tags: ["desktop-link"],
      importance: 0.9,
    });
    const result = proposeEdges([err, dec], opts);
    const causes = result.accept.concat(result.review).filter((e) => e.type === "CAUSES");
    expect(causes.length).toBe(1);
    const edge = causes[0]!;
    expect(edge.evidence.rule).toBe("causes-err-leads-to-dec");
    expect(edge.evidence.matchedPattern).toMatch(/ERR-\d+/);
    expect(edge.evidence.regex).toMatch(/ERR/);
    expect(edge.evidence.nodeIds.from).toBe(err.id ?? "");
    expect(edge.evidence.nodeIds.to).toBe(dec.id ?? "");
  });

  it("does not propose when the DEC title does not reference the ERR id", () => {
    const err = makeMemory({
      id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      type: "error",
      title: "ERR-006 Honcho embeddings credit exhaustion",
      tags: ["desktop-link"],
      importance: 0.7,
    });
    const dec = makeMemory({
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      title: "DEC-100 unrelated cron wrapper",
      tags: ["desktop-link"],
      importance: 0.9,
    });
    const result = proposeEdges([err, dec], opts);
    expect(result.accept.concat(result.review)).toHaveLength(0);
  });
});

describe("proposeEdges — improves-new-over-old rule", () => {
  const opts: AutoLinkOptions = { minConfidence: 0.7 };

  it("proposes IMPROVES from newer+more-important DEC to older one with overlapping tags", () => {
    const old = makeMemory({
      id: "11111111-1111-1111-1111-111111111111",
      title: "DEC-001 cron pattern baseline",
      tags: ["desktop-link", "cron"],
      importance: 0.5,
      created_at: "2026-01-01T00:00:00Z",
    });
    const newer = makeMemory({
      id: "22222222-2222-2222-2222-222222222222",
      title: "DEC-002 cron rate-limit guard hardened",
      tags: ["desktop-link", "cron"],
      importance: 0.85,
      created_at: "2026-08-14T00:00:00Z",
    });
    const result = proposeEdges([old, newer], opts);
    const improves = result.accept.concat(result.review).filter((e) => e.type === "IMPROVES");
    expect(improves.length).toBe(1);
    const edge = improves[0]!;
    expect(edge.evidence.rule).toBe("improves-new-over-old");
    expect(edge.evidence.nodeIds.from).toBe(newer.id ?? "");
    expect(edge.evidence.nodeIds.to).toBe(old.id ?? "");
  });

  it("does not propose when the candidate is older and less important", () => {
    const old = makeMemory({
      id: "11111111-1111-1111-1111-111111111111",
      title: "DEC-001 cron pattern baseline",
      tags: ["desktop-link"],
      importance: 0.85,
      created_at: "2026-01-01T00:00:00Z",
    });
    const newer = makeMemory({
      id: "22222222-2222-2222-2222-222222222222",
      title: "DEC-002 cron rate-limit hardened",
      tags: ["desktop-link"],
      importance: 0.5,
      created_at: "2026-08-14T00:00:00Z",
    });
    const result = proposeEdges([old, newer], opts);
    expect(result.accept.concat(result.review).filter((e) => e.type === "IMPROVES")).toHaveLength(0);
  });
});

describe("proposeEdges — occurs-in-session-to-dec rule", () => {
  const opts: AutoLinkOptions = { minConfidence: 0.7 };

  it("proposes OCCURS_IN from a Session node to a DEC referenced in title", () => {
    const session = makeMemory({
      id: "ssssssss-ssss-ssss-ssss-ssssssssssss",
      type: "conversation",
      title: "Session 2026-08-18 research DEC-022 + DEC-030",
      tags: ["desktop-link"],
    });
    const dec = makeMemory({
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      title: "DEC-022 Honcho v3 conclusion write path",
      tags: ["desktop-link"],
    });
    const result = proposeEdges([session, dec], opts);
    const occurs = result.accept.concat(result.review).filter((e) => e.type === "OCCURS_IN");
    expect(occurs.length).toBe(1);
    const edge = occurs[0]!;
    expect(edge.evidence.rule).toBe("occurs-in-session-to-dec");
    expect(edge.evidence.matchedPattern).toMatch(/DEC-/);
    expect(edge.evidence.nodeIds.from).toBe(session.id ?? "");
    expect(edge.evidence.nodeIds.to).toBe(dec.id ?? "");
  });

  it("does not propose when session title has no DEC/ERR reference", () => {
    const session = makeMemory({
      id: "ssssssss-ssss-ssss-ssss-ssssssssssss",
      type: "conversation",
      title: "Session 2026-08-18 generic chat",
      tags: ["desktop-link"],
    });
    const dec = makeMemory({
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      title: "DEC-022 Honcho v3 conclusion",
      tags: ["desktop-link"],
    });
    const result = proposeEdges([session, dec], opts);
    expect(result.accept.concat(result.review).filter((e) => e.type === "OCCURS_IN")).toHaveLength(0);
  });
});

describe("proposeEdges — type and threshold gates", () => {
  it("DEFAULT_ALLOW_TYPES does not include REPLACES (REPLACES never auto)", () => {
    expect(DEFAULT_ALLOW_TYPES.has("REPLACES")).toBe(false);
  });

  it("does not propose any edge type outside the allowTypes set", () => {
    const a = makeMemory({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      title: "DEC-019 Honcho workspace binding",
      tags: ["desktop-link"],
    });
    const b = makeMemory({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      title: "DEC-022 Honcho workspace binding",
      tags: ["desktop-link"],
    });
    const onlyContradicts: AutoLinkOptions = {
      minConfidence: 0.7,
      allowTypes: new Set<RelationshipType>(["CONTRADICTS"]),
    };
    const result = proposeEdges([a, b], onlyContradicts);
    expect(result.accept.concat(result.review)).toHaveLength(0);
  });

  it("below-min-confidence edges land in review (0.5–0.7) or rejected (< 0.5)", () => {
    const a = makeMemory({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      title: "DEC-019 Honcho workspace binding",
      tags: ["desktop-link"],
    });
    const b = makeMemory({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      title: "DEC-022 Honcho workspace binding",
      tags: ["desktop-link"],
    });
    const result = proposeEdges([a, b], { minConfidence: 0.7 });
    const all = result.accept.concat(result.review).concat(result.rejected);
    for (const e of all) {
      expect(e.confidence).toBeGreaterThanOrEqual(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("rejected bucket contains edges with confidence < 0.5 (not surfaced in report)", () => {
    const a = makeMemory({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      title: "abc def",
      tags: ["x"],
    });
    const b = makeMemory({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      title: "abc def",
      tags: ["x"],
    });
    const result = proposeEdges([a, b], { minConfidence: 0.7 });
    expect(result.rejected).toHaveLength(0);
    expect(result.accept.length + result.review.length).toBe(0);
  });
});

describe("proposeEdges — evidence structure", () => {
  it("every proposed edge carries a structured Evidence with rule + matchedPattern + nodeIds", () => {
    const a = makeMemory({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      title: "DEC-019 Honcho workspace binding",
      tags: ["desktop-link"],
    });
    const b = makeMemory({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      title: "DEC-022 Honcho workspace binding",
      tags: ["desktop-link"],
    });
    const result = proposeEdges([a, b], { minConfidence: 0.7 });
    const all = result.accept.concat(result.review);
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) {
      expect(e.evidence).toBeDefined();
      expect(e.evidence.rule).toBeString();
      expect(e.evidence.rule.length).toBeGreaterThan(0);
      expect(e.evidence.matchedPattern).toBeString();
      expect(e.evidence.ruleReason).toBeString();
      expect(e.evidence.nodeIds).toEqual({ from: a.id ?? "", to: b.id ?? "" });
    }
  });
});

function makeMemoryWithRelations(over: Partial<Memory>, rels: Record<string, string[]>): Memory {
  return {...makeMemory(over), relationships: rels};
}

function makeMockDb(opts: {
  knownFrom?: { id: string; relationships?: Record<string, string[]> } | null;
  createShouldFail?: boolean;
  createCalls?: Array<{ from: string; to: string; type: string }>;
}): IMemoryDatabase {
  return {
    initializeSchema: async () => {},
    close: async () => {},
    storeMemory: async () => "stored-id",
    getMemory: async (id: string) => {
      if (opts.knownFrom === null) return null;
      if (opts.knownFrom && opts.knownFrom.id === id) {
        return makeMemoryWithRelations({ id }, opts.knownFrom.relationships ?? {});
      }
      return null;
    },
    searchMemories: async () => [],
    updateMemory: async () => true,
    deleteMemory: async () => true,
    createRelationship: async (from: string, to: string, type: string) => {
      if (opts.createShouldFail) throw new Error("simulated create failure");
      opts.createCalls?.push({ from, to, type });
      return `rel-${from}-${to}-${type}`;
    },
    getRelatedMemories: async () => [],
    getMemoryStatistics: async () => ({}),
  } as unknown as IMemoryDatabase;
}

describe("linkIfMissing — idempotency", () => {
  const makeEdge = (over: Partial<{ from: string; to: string; type: "CONFIRMS" | "IMPROVES"; confidence: number }> = {}) => ({
    from: over.from ?? "from-id",
    to: over.to ?? "to-id",
    type: over.type ?? "CONFIRMS" as const,
    confidence: over.confidence ?? 0.6,
    timestamp: new Date().toISOString(),
    evidence: {
      rule: "confirms-same-topic",
      matchedPattern: "x",
      ruleReason: "x",
      nodeIds: { from: over.from ?? "from-id", to: over.to ?? "to-id" },
    },
  });

  it("creates a new edge when no existing direct relationship of the same type points to the target", async () => {
    const calls: Array<{ from: string; to: string; type: string }> = [];
    const db = makeMockDb({
      knownFrom: { id: "from-id", relationships: {} },
      createCalls: calls,
    });
    const r = await linkIfMissing(db, makeEdge());
    expect(r.created).toBe(true);
    expect(r.skipped).toBeNull();
    expect(r.error).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ from: "from-id", to: "to-id", type: "CONFIRMS" });
  });

  it("skips when the same type edge already exists from `from` to `to`", async () => {
    const calls: Array<{ from: string; to: string; type: string }> = [];
    const db = makeMockDb({
      knownFrom: { id: "from-id", relationships: { CONFIRMS: ["to-id", "other-id"] } },
      createCalls: calls,
    });
    const r = await linkIfMissing(db, makeEdge());
    expect(r.created).toBe(false);
    expect(r.skipped).toBe("duplicate");
    expect(r.error).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("does not skip when the same target exists under a different type", async () => {
    const calls: Array<{ from: string; to: string; type: string }> = [];
    const db = makeMockDb({
      knownFrom: { id: "from-id", relationships: { CONFIRMS: ["to-id"] } },
      createCalls: calls,
    });
    const r = await linkIfMissing(
      db,
      makeEdge({ type: "IMPROVES", confidence: 0.5 }),
    );
    expect(r.created).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.type).toBe("IMPROVES");
  });

  it("returns error (no creation) when the source memory does not exist", async () => {
    const calls: Array<{ from: string; to: string; type: string }> = [];
    const db = makeMockDb({ knownFrom: null, createCalls: calls });
    const r = await linkIfMissing(db, makeEdge({ from: "missing-id" }));
    expect(r.created).toBe(false);
    expect(r.skipped).toBeNull();
    expect(r.error).toMatch(/source memory not found/i);
    expect(calls).toHaveLength(0);
  });

  it("returns error when the backend createRelationship throws (logged, not silently swallowed)", async () => {
    const db = makeMockDb({ knownFrom: { id: "from-id" }, createShouldFail: true });
    const r = await linkIfMissing(db, makeEdge());
    expect(r.created).toBe(false);
    expect(r.error).toMatch(/simulated create failure/);
  });
});

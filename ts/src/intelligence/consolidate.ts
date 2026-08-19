import type { Memory } from "../models.js";

export type ConsolidateCandidate = {
  id: string;
  title: string;
  reason: string;
  confidence: number;
  impact: string;
  related: string[];
};

export type ConsolidateReport = {
  generatedAtIso: string;
  total: number;
  duplicates: ConsolidateCandidate[];
  superseded: ConsolidateCandidate[];
  archive: ConsolidateCandidate[];
  replacesGuarded: string;
  dialectLimits: string[];
  mutations: number;
};

export type ConsolidateOptions = {
  supersededAgeDays: number;
  supersededImportanceMax: number;
  archiveAgeDays: number;
  archiveImportanceMax: number;
};

export const DEFAULT_CONSOLIDATE_OPTIONS: ConsolidateOptions = {
  supersededAgeDays: 30,
  supersededImportanceMax: 0.4,
  archiveAgeDays: 180,
  archiveImportanceMax: 0,
};

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(dec|err)-\d+\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function passesAgeAndImportanceGate(
  m: Memory,
  now: Date,
  maxAgeDays: number,
  maxImportance: number,
): boolean {
  const created = Date.parse(String(m.created_at));
  if (Number.isNaN(created)) return false;
  const ageDays = (now.getTime() - created) / (24 * 60 * 60 * 1000);
  if (ageDays < maxAgeDays) return false;
  if (m.importance > maxImportance) return false;
  return true;
}

export function detectDuplicateByTitle(memories: Memory[]): ConsolidateCandidate[] {
  const byNorm = new Map<string, Memory[]>();
  for (const m of memories) {
    const key = normalizeTitle(m.title);
    const arr = byNorm.get(key) ?? [];
    arr.push(m);
    byNorm.set(key, arr);
  }
  const out: ConsolidateCandidate[] = [];
  for (const [, group] of byNorm) {
    if (group.length < 2) continue;
    for (const m of group) {
      const related = group
        .filter((other) => other.id !== undefined && other.id !== m.id)
        .map((other) => (other.id as string));
      out.push({
        id: m.id ?? "",
        title: m.title,
        reason: `exact-title-match: shares normalized title with ${related.length} other memor(ies)`,
        confidence: 0.9,
        impact: `remove 1 of ${group.length} (keep oldest); archive the rest`,
        related,
      });
    }
  }
  return out;
}

export function detectSupersededByAge(
  memories: Memory[],
  now: Date,
  options: ConsolidateOptions = DEFAULT_CONSOLIDATE_OPTIONS,
): ConsolidateCandidate[] {
  const out: ConsolidateCandidate[] = [];
  for (const m of memories) {
    if (!passesAgeAndImportanceGate(m, now, options.supersededAgeDays, options.supersededImportanceMax)) {
      continue;
    }
    if (m.last_accessed !== undefined && m.last_accessed !== null) continue;
    out.push({
      id: m.id ?? "",
      title: m.title,
      reason:
        `heuristic: old + low-importance + never-accessed — verify against content before any supersession proposal`,
      confidence: 0.6,
      impact: `review content; supersede only after manual verification`,
      related: [],
    });
  }
  return out;
}

export function detectArchiveCandidates(
  memories: Memory[],
  now: Date,
  options: ConsolidateOptions = DEFAULT_CONSOLIDATE_OPTIONS,
): ConsolidateCandidate[] {
  const out: ConsolidateCandidate[] = [];
  for (const m of memories) {
    if (!passesAgeAndImportanceGate(m, now, options.archiveAgeDays, options.archiveImportanceMax)) {
      continue;
    }
    const rels = m.relationships ?? {};
    const hasRels = Object.values(rels).some((arr) => Array.isArray(arr) && arr.length > 0);
    if (hasRels) continue;
    out.push({
      id: m.id ?? "",
      title: m.title,
      reason: `old + importance<=${options.archiveImportanceMax} + no outbound relations`,
      confidence: 0.7,
      impact: `archive; preserve for forensic audit`,
      related: [],
    });
  }
  return out;
}

export function generateConsolidationReport(
  memories: Memory[],
  now: Date,
  options: ConsolidateOptions = DEFAULT_CONSOLIDATE_OPTIONS,
): ConsolidateReport {
  const duplicates = detectDuplicateByTitle(memories);
  const superseded = detectSupersededByAge(memories, now, options);
  const archive = detectArchiveCandidates(memories, now, options);
  return {
    generatedAtIso: now.toISOString(),
    total: memories.length,
    duplicates,
    superseded,
    archive,
    replacesGuarded:
      "no REPLACES / merge proposed without an explicit human gate (per #22 / #31 spec); always requires --apply with operator confirmation",
    dialectLimits: [],
    mutations: 0,
  };
}

export function formatReportMarkdown(report: ConsolidateReport): string {
  const lines: string[] = [];
  lines.push(`# Consolidation Dry-Run Report`);
  lines.push(`Generated: ${report.generatedAtIso}`);
  lines.push(`Corpus: total=${report.total} memories`);
  lines.push("");
  lines.push("## REPLACES guarded");
  lines.push(report.replacesGuarded);
  lines.push("");
  lines.push("## Dialect limits detected");
  if (report.dialectLimits.length === 0) {
    lines.push("- none");
  } else {
    for (const d of report.dialectLimits) lines.push(`- ${d}`);
  }
  lines.push("");
  lines.push("## Candidates (idempotent, ordered by confidence)");
  lines.push(`### duplicates (${report.duplicates.length})`);
  for (const c of report.duplicates) {
    lines.push(`- ${c.id} — confidence ${c.confidence}`);
    lines.push(`  - reason: ${c.reason}`);
    lines.push(`  - related: ${c.related.join(", ") || "(none)"}`);
    lines.push(`  - impact: ${c.impact}`);
  }
  lines.push(`### superseded (${report.superseded.length})`);
  for (const c of report.superseded) {
    lines.push(`- ${c.id} — confidence ${c.confidence}`);
    lines.push(`  - reason: ${c.reason}`);
  }
  lines.push(`### archive (${report.archive.length})`);
  for (const c of report.archive) {
    lines.push(`- ${c.id} — confidence ${c.confidence}`);
    lines.push(`  - reason: ${c.reason}`);
  }
  lines.push("");
  lines.push(`## Mutations: ${report.mutations}`);
  lines.push("- (dry-run guarantees no writes; --apply not implemented in MVP)");
  return lines.join("\n") + "\n";
}

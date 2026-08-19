/**
 * Tests for consolidation logic (#31).
 */

import { describe, it, expect } from "bun:test";
import {
  detectDuplicateByTitle,
  detectSupersededByAge,
  detectArchiveCandidates,
  generateConsolidationReport,
  formatReportMarkdown,
  DEFAULT_CONSOLIDATE_OPTIONS,
  type ConsolidateOptions,
} from "../src/intelligence/consolidate.js";
import type { Memory } from "../src/models.js";

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

describe("detectDuplicateByTitle", () => {
  it("flags two memories with the exact same normalized title", () => {
    const result = detectDuplicateByTitle([
      makeMemory({ id: "a", title: "DEC-001 cron rate-limit guard", created_at: "2026-01-01T00:00:00Z" }),
      makeMemory({ id: "b", title: "DEC-099 cron rate-limit guard", created_at: "2026-02-01T00:00:00Z" }),
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(result[0]?.reason).toMatch(/exact-title-match/);
    expect(result[0]?.confidence).toBe(0.9);
  });

  it("does NOT match near-duplicates (Levenshtein / fuzzy) — out of MVP scope", () => {
    const result = detectDuplicateByTitle([
      makeMemory({ id: "a", title: "DEC-001 cron rate-limit guard", created_at: "2026-01-01T00:00:00Z" }),
      makeMemory({ id: "b", title: "DEC-099 cron rate-limit guards", created_at: "2026-02-01T00:00:00Z" }),
    ]);
    expect(result).toEqual([]);
  });

  it("normalizes whitespace and case before comparing", () => {
    const result = detectDuplicateByTitle([
      makeMemory({ id: "a", title: "DEC-001  Cron  Rate-Limit", created_at: "2026-01-01T00:00:00Z" }),
      makeMemory({ id: "b", title: "DEC-099 cron rate-limit", created_at: "2026-02-01T00:00:00Z" }),
    ]);
    expect(result).toHaveLength(2);
  });

  it("returns empty when no exact-title collisions", () => {
    const result = detectDuplicateByTitle([
      makeMemory({ id: "a", title: "DEC-001 cron rate-limit guard" }),
      makeMemory({ id: "b", title: "DEC-002 morning briefing storm" }),
    ]);
    expect(result).toEqual([]);
  });
});

describe("detectSupersededByAge", () => {
  const now = new Date("2026-08-19T00:00:00Z");

  it("flags a memory that is old + low-importance + never-accessed", () => {
    const old = new Date("2026-07-01T00:00:00Z").toISOString();
    const result = detectSupersededByAge(
      [
        makeMemory({
          id: "a",
          title: "old low-importance memory",
          importance: 0.3,
          created_at: old,
          last_accessed: null,
        }),
      ],
      now,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("a");
    expect(result[0]?.reason).toMatch(/heuristic: old \+ low-importance \+ never-accessed/);
    expect(result[0]?.confidence).toBe(0.6);
  });

  it("does NOT flag a recently created memory even if importance is low", () => {
    const recent = new Date("2026-08-15T00:00:00Z").toISOString();
    const result = detectSupersededByAge(
      [makeMemory({ id: "a", importance: 0.1, created_at: recent, last_accessed: null })],
      now,
    );
    expect(result).toEqual([]);
  });

  it("does NOT flag a memory that has been accessed (last_accessed != null)", () => {
    const old = new Date("2026-07-01T00:00:00Z").toISOString();
    const result = detectSupersededByAge(
      [makeMemory({ id: "a", importance: 0.3, created_at: old, last_accessed: "2026-08-01T00:00:00Z" })],
      now,
    );
    expect(result).toEqual([]);
  });

  it("does NOT flag a high-importance memory", () => {
    const old = new Date("2026-07-01T00:00:00Z").toISOString();
    const result = detectSupersededByAge(
      [makeMemory({ id: "a", importance: 0.9, created_at: old, last_accessed: null })],
      now,
    );
    expect(result).toEqual([]);
  });
});

describe("detectArchiveCandidates", () => {
  const now = new Date("2026-08-19T00:00:00Z");

  it("flags a very old, importance-0, no-relations memory", () => {
    const old = new Date("2026-01-01T00:00:00Z").toISOString();
    const result = detectArchiveCandidates(
      [makeMemory({ id: "a", importance: 0, created_at: old })],
      now,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBe(0.7);
  });

  it("does NOT flag a memory that has outbound relations", () => {
    const old = new Date("2026-01-01T00:00:00Z").toISOString();
    const result = detectArchiveCandidates(
      [
        makeMemory({
          id: "a",
          importance: 0,
          created_at: old,
          relationships: { RELATED_TO: ["other-id"] },
        }),
      ],
      now,
    );
    expect(result).toEqual([]);
  });

  it("does NOT flag a recent memory", () => {
    const recent = new Date("2026-08-15T00:00:00Z").toISOString();
    const result = detectArchiveCandidates(
      [makeMemory({ id: "a", importance: 0, created_at: recent })],
      now,
    );
    expect(result).toEqual([]);
  });
});

describe("generateConsolidationReport", () => {
  it("returns a report with total, all three buckets, mutations=0, replacesGuarded", () => {
    const old = new Date("2026-01-01T00:00:00Z").toISOString();
    const now = new Date("2026-08-19T00:00:00Z");
    const memories = [
      makeMemory({ id: "a", title: "X", created_at: old, importance: 0.3, last_accessed: null }),
      makeMemory({ id: "b", title: "X", created_at: old, importance: 0.3, last_accessed: null }),
      makeMemory({ id: "c", importance: 0, created_at: old }),
    ];
    const report = generateConsolidationReport(memories, now);
    expect(report.total).toBe(3);
    expect(report.duplicates.length).toBeGreaterThanOrEqual(2);
    expect(report.superseded.length).toBeGreaterThanOrEqual(2);
    expect(report.archive.length).toBeGreaterThanOrEqual(1);
    expect(report.mutations).toBe(0);
    expect(report.replacesGuarded).toMatch(/human gate/);
  });

  it("is idempotent for the same corpus (no state)", () => {
    const old = new Date("2026-01-01T00:00:00Z").toISOString();
    const now = new Date("2026-08-19T00:00:00Z");
    const memories = [makeMemory({ id: "a", title: "X", created_at: old })];
    const r1 = generateConsolidationReport(memories, now);
    const r2 = generateConsolidationReport(memories, now);
    expect(r1).toEqual(r2);
  });
});

describe("formatReportMarkdown", () => {
  it("includes the three buckets, REPLACES guarded, and Mutations: 0", () => {
    const old = new Date("2026-01-01T00:00:00Z").toISOString();
    const now = new Date("2026-08-19T00:00:00Z");
    const memories = [
      makeMemory({ id: "a", title: "X", created_at: old, importance: 0.3, last_accessed: null }),
      makeMemory({ id: "b", title: "X", created_at: old, importance: 0.3, last_accessed: null }),
    ];
    const report = generateConsolidationReport(memories, now);
    const md = formatReportMarkdown(report);
    expect(md).toMatch(/# Consolidation Dry-Run Report/);
    expect(md).toMatch(/## REPLACES guarded/);
    expect(md).toMatch(/human gate/);
    expect(md).toMatch(/## Candidates/);
    expect(md).toMatch(/### duplicates \(2\)/);
    expect(md).toMatch(/### superseded/);
    expect(md).toMatch(/### archive/);
    expect(md).toMatch(/## Mutations: 0/);
  });
});

describe("DEFAULT_CONSOLIDATE_OPTIONS", () => {
  it("exposes the documented thresholds (superseded=30d/0.4, archive=180d/0)", () => {
    expect(DEFAULT_CONSOLIDATE_OPTIONS.supersededAgeDays).toBe(30);
    expect(DEFAULT_CONSOLIDATE_OPTIONS.supersededImportanceMax).toBe(0.4);
    expect(DEFAULT_CONSOLIDATE_OPTIONS.archiveAgeDays).toBe(180);
    expect(DEFAULT_CONSOLIDATE_OPTIONS.archiveImportanceMax).toBe(0);
  });

  it("ConsolidateOptions is constructible for tests", () => {
    const opts: ConsolidateOptions = { ...DEFAULT_CONSOLIDATE_OPTIONS };
    expect(opts.archiveAgeDays).toBe(180);
  });
});

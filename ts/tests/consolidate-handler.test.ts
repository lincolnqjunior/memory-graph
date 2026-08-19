/**
 * Tests for the consolidate tool handler (#31).
 *
 * Covers: tag path, --memory-id path, --out path, ConsolidateError throw,
 * and dialect-limit detection (when db.searchMemories throws).
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleConsolidate,
  ConsolidateError,
} from "../src/tools/consolidate.js";
import type { IMemoryDatabase } from "../src/database.js";
import type { Memory } from "../src/models.js";

function makeMemory(over: Partial<Memory>): Memory {
  return {
    id: over.id ?? "00000000-0000-0000-0000-000000000000",
    type: over.type ?? "solution",
    title: over.title ?? "untitled",
    content: over.content ?? "",
    tags: over.tags ?? ["desktop-link"],
    importance: over.importance ?? 0.5,
    confidence: over.confidence ?? 0.8,
    created_at: over.created_at ?? new Date().toISOString(),
    updated_at: over.updated_at ?? new Date().toISOString(),
    version: over.version ?? 1,
    usage_count: over.usage_count ?? 0,
    ...over,
  };
}

function makeMockDb(memories: Memory[], opts: { throwOnSearch?: Error } = {}): IMemoryDatabase {
  return {
    initializeSchema: async () => {},
    close: async () => {},
    storeMemory: async () => "stored-id",
    getMemory: async (id: string) => memories.find((m) => m.id === id) ?? null,
    searchMemories: async () => {
      if (opts.throwOnSearch !== undefined) {
        throw opts.throwOnSearch;
      }
      return memories;
    },
    updateMemory: async () => true,
    deleteMemory: async () => true,
    createRelationship: async () => "rel-id",
    getRelatedMemories: async () => [],
    getMemoryStatistics: async () => ({}),
  } as unknown as IMemoryDatabase;
}

describe("handleConsolidate — handler (#31)", () => {
  it("throws ConsolidateError when neither --tag nor --memory-id is provided", async () => {
    const db = makeMockDb([]);
    const result = (await handleConsolidate(db, {})) as { isError: boolean; text: string };
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Provide --tag.*--memory-id/);
  });

  it("tag path: returns a markdown report and does not mutate the graph", async () => {
    const memories: Memory[] = [
      makeMemory({
        id: "a",
        title: "DEC-001 cron rate-limit guard",
        created_at: "2026-01-01T00:00:00Z",
      }),
      makeMemory({
        id: "b",
        title: "DEC-002 morning briefing storm",
        created_at: "2026-08-15T00:00:00Z",
      }),
    ];
    const db = makeMockDb(memories);
    const result = (await handleConsolidate(db, { tag: "desktop-link" })) as {
      isError: boolean;
      text: string;
    };
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/# Consolidation Dry-Run Report/);
    expect(result.text).toMatch(/Corpus: total=2 memories/);
    expect(result.text).toMatch(/## REPLACES guarded/);
    expect(result.text).toMatch(/## Mutations: 0/);
  });

  it("memory-id path: returns a report scoped to a single memory", async () => {
    const mem = makeMemory({
      id: "single-id",
      title: "DEC-007 single-memory test",
      created_at: "2026-08-15T00:00:00Z",
    });
    const db = makeMockDb([mem]);
    const result = (await handleConsolidate(db, { memory_id: "single-id" })) as {
      isError: boolean;
      text: string;
    };
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/Corpus: total=1 memories/);
  });

  it("--out path: writes the report to disk and announces the artifact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consolidate-out-"));
    try {
      const outPath = join(dir, "report.md");
      const memories: Memory[] = [makeMemory({ id: "a", title: "X" })];
      const db = makeMockDb(memories);
      const result = (await handleConsolidate(db, {
        tag: "desktop-link",
        out_path: outPath,
      })) as { isError: boolean; text: string };
      expect(result.isError).toBe(false);
      expect(existsSync(outPath)).toBe(true);
      const onDisk = readFileSync(outPath, "utf8");
      expect(onDisk).toMatch(/# Consolidation Dry-Run Report/);
      expect(result.text).toMatch(/consolidate --dry-run wrote:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dialect limit detection: surfaces a falkordb-down error in the report", async () => {
    const db = makeMockDb([], { throwOnSearch: new Error("ECONNREFUSED") });
    const result = (await handleConsolidate(db, { tag: "desktop-link" })) as {
      isError: boolean;
      text: string;
    };
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/## Dialect limits detected/);
    expect(result.text).toMatch(/falkordb-down: Error: ECONNREFUSED/);
    expect(result.text).toMatch(/Corpus: total=0 memories/);
  });

  it("honors custom superseded_age_days and archive_age_days thresholds", async () => {
    const recent = new Date().toISOString();
    const mem = makeMemory({
      id: "a",
      title: "recent low-importance",
      importance: 0,
      created_at: recent,
    });
    const db = makeMockDb([mem]);
    const result = (await handleConsolidate(db, {
      tag: "desktop-link",
      superseded_age_days: 0,
      archive_age_days: 0,
    })) as { isError: boolean; text: string };
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/### superseded \(1\)/);
    expect(result.text).toMatch(/### archive \(1\)/);
  });
});

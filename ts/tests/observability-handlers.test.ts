/**
 * Tests for the observability prefix in CLI tool handlers (#28 C2).
 *
 * Each of the 4 hit-rendering handlers (handleSearchMemories,
 * handleRecallMemories, handleContextualSearch, handleGetRelatedMemories)
 * must prepend `[observability=X] ` to the title when an
 * observability_classifier is supplied in args. Without a classifier,
 * output is unchanged (zero behaviour change for existing tests).
 */

import { describe, it, expect } from "bun:test";
import {
  handleSearchMemories,
  handleRecallMemories,
  handleContextualSearch,
} from "../src/tools/search.js";
import { handleGetRelatedMemories } from "../src/tools/relationship.js";
import type { IMemoryDatabase } from "../src/database.js";
import type { Memory, Relationship } from "../src/models.js";
import type { Classifier } from "../src/intelligence/observability.js";

function makeMemory(
  over: Partial<Memory> & Pick<Memory, "type" | "title">,
): Memory {
  return {
    id: over.id ?? "00000000-0000-0000-0000-000000000000",
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

function makeMockDb(memories: Memory[]): IMemoryDatabase {
  return {
    initializeSchema: async () => {},
    close: async () => {},
    storeMemory: async () => "stored-id",
    getMemory: async (id: string) => memories.find((m) => m.id === id) ?? null,
    searchMemories: async () => memories,
    updateMemory: async () => true,
    deleteMemory: async () => true,
    createRelationship: async () => "rel-id",
    getRelatedMemories: async () =>
      memories.map(
        (m) =>
          [m, { type: "RELATED_TO", properties: { strength: 0.5 } } as unknown as Relationship],
      ),
    getMemoryStatistics: async () => ({}),
  } as unknown as IMemoryDatabase;
}

async function run(
  handler: (db: IMemoryDatabase, args: Record<string, unknown>) => Promise<unknown>,
  args: Record<string, unknown>,
): Promise<string> {
  const result = (await handler(makeMockDb([]), args)) as {
    text: string;
    isError: boolean;
  };
  return result.text;
}

describe("handleSearchMemories — observability prefix (#28)", () => {
  it("prepends [observability=exact] when a classifier is supplied", async () => {
    const db = makeMockDb([
      makeMemory({ type: "solution", title: "DEC-001 foo", id: "u-1" }),
    ]);
    const result = (await handleSearchMemories(db, {
      tags: ["desktop-link"],
      observability_classifier: (() => "exact") as Classifier,
    })) as { text: string };
    expect(result.text).toContain("**1. [observability=exact] DEC-001 foo** (ID: u-1)");
  });

  it("emits no prefix when no classifier is supplied (existing behavior)", async () => {
    const db = makeMockDb([
      makeMemory({ type: "solution", title: "DEC-001 foo", id: "u-1" }),
    ]);
    const result = (await handleSearchMemories(db, { tags: ["desktop-link"] })) as {
      text: string;
    };
    expect(result.text).toContain("**1. DEC-001 foo** (ID: u-1)");
    expect(result.text).not.toContain("[observability=");
  });
});

describe("handleRecallMemories — observability prefix (#28)", () => {
  it("prepends [observability=estimated] for an estimated-classified memory", async () => {
    const db = makeMockDb([
      makeMemory({ type: "solution", title: "DEC-999 no-ADR", id: "u-2" }),
    ]);
    const result = (await handleRecallMemories(db, {
      query: "x",
      observability_classifier: (() => "estimated") as Classifier,
    })) as { text: string };
    expect(result.text).toContain("**1. [observability=estimated] DEC-999 no-ADR**");
  });
});

describe("handleContextualSearch — observability prefix (#28)", () => {
  it("prepends on each contextual hit", async () => {
    const db = makeMockDb([
      makeMemory({ type: "solution", title: "DEC-001 foo", id: "u-3" }),
      makeMemory({ type: "error", title: "ERR-006 bar", id: "u-4" }),
    ]);
    const result = (await handleContextualSearch(db, {
      memory_id: "u-3",
      query: "x",
      observability_classifier: ((m: Pick<Memory, "type" | "title">) =>
        m.type === "error" ? "estimated" : "exact") as Classifier,
    })) as { text: string };
    expect(result.text).toContain("1. **[observability=exact] DEC-001 foo**");
    expect(result.text).toContain("2. **[observability=estimated] ERR-006 bar**");
  });
});

describe("handleGetRelatedMemories — observability prefix (#28)", () => {
  it("prepends [observability=unavailable] when classifier says so", async () => {
    const db = makeMockDb([
      makeMemory({ type: "conversation", title: "Session 2026-08-18", id: "u-5" }),
    ]);
    const result = (await handleGetRelatedMemories(db, {
      memory_id: "u-5",
      observability_classifier: (() => "unavailable") as Classifier,
    })) as { text: string };
    expect(result.text).toContain("**1. [observability=unavailable] Session 2026-08-18**");
  });
});

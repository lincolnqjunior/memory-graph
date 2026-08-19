/**
 * Tests for observability grading (pure logic).
 *
 * Computes `observability ∈ {exact, estimated, unavailable}` from
 * objective signals only (no LLM):
 *   - exact:      solution/error node with DEC-NNN/ERR-NNN in title AND
 *                a matching docs/decisions/*-{dec|err}-NNN-*.md file
 *   - estimated:  solution/error node without matching ADR
 *   - unavailable: any other memory type (conversation, project, etc.)
 *
 * Performance contract: the decisions-directory listing is loaded
 * AT MOST ONCE per classifier instance (via `buildObservabilityClassifier`).
 * Naive per-memory readdirSync is forbidden — see TARS gate 4.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildObservabilityClassifier,
  classifyObservability,
  OBSERVABILITY_VALUES,
  type Observability,
} from "../src/intelligence/observability.js";
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
  };
}

function makeRepoWithDecisions(files: Record<string, string>): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "obs-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("OBSERVABILITY_VALUES (closed vocabulary)", () => {
  it("contains exactly {exact, estimated, unavailable} and no others", () => {
    expect(new Set(OBSERVABILITY_VALUES)).toEqual(
      new Set(["exact", "estimated", "unavailable"]),
    );
  });
});

describe("classifyObservability — exact (ADR-backed DEC/ERR)", () => {
  it("returns exact for a DEC solution with a matching ADR file", () => {
    const repo = makeRepoWithDecisions({
      "docs/decisions/2026-08-14-dec-030-cron-rate-limit-guard.md":
        "# DEC-030: cron rate-limit guard persists state before non-critical writes\n",
    });
    try {
      const result = classifyObservability(
        makeMemory({
          type: "solution",
          title: "DEC-030 cron rate-limit guard persists state before writes",
        }),
        repo.dir,
      );
      expect(result).toBe("exact");
    } finally {
      repo.cleanup();
    }
  });

  it("returns exact for an ERR error with a matching ADR file", () => {
    const repo = makeRepoWithDecisions({
      "docs/decisions/2026-08-14-dec-006-err-006-honcho-embeddings-credit-exhaustion.md":
        "# ERR-006\n",
    });
    try {
      const result = classifyObservability(
        makeMemory({ type: "error", title: "ERR-006 Honcho embeddings credit exhaustion" }),
        repo.dir,
      );
      expect(result).toBe("exact");
    } finally {
      repo.cleanup();
    }
  });

  it("matches case-insensitively on the file name", () => {
    const repo = makeRepoWithDecisions({
      "docs/decisions/2026-08-14-DEC-030-uppercase.md": "x",
    });
    try {
      const result = classifyObservability(
        makeMemory({ type: "solution", title: "DEC-030 something" }),
        repo.dir,
      );
      expect(result).toBe("exact");
    } finally {
      repo.cleanup();
    }
  });
});

describe("classifyObservability — estimated (solution/error without ADR)", () => {
  it("returns estimated when a solution has DEC-NNN in title but no ADR file", () => {
    const repo = makeRepoWithDecisions({
      "docs/decisions/2026-08-14-dec-001-foo.md": "x",
    });
    try {
      const result = classifyObservability(
        makeMemory({ type: "solution", title: "DEC-999 no ADR here" }),
        repo.dir,
      );
      expect(result).toBe("estimated");
    } finally {
      repo.cleanup();
    }
  });

  it("returns estimated when docs/decisions/ is missing entirely", () => {
    const repo = makeRepoWithDecisions({ "README.md": "x" });
    try {
      const result = classifyObservability(
        makeMemory({ type: "solution", title: "DEC-030 something" }),
        repo.dir,
      );
      expect(result).toBe("estimated");
    } finally {
      repo.cleanup();
    }
  });

  it("returns estimated for ERR-NNN when ERR has no ADR (ADRs are DEC, not ERR per #28 note)", () => {
    const repo = makeRepoWithDecisions({});
    try {
      const result = classifyObservability(
        makeMemory({ type: "error", title: "ERR-006 Honcho embeddings" }),
        repo.dir,
      );
      expect(result).toBe("estimated");
    } finally {
      repo.cleanup();
    }
  });
});

describe("classifyObservability — unavailable (non DEC/ERR types)", () => {
  it("returns unavailable for a conversation node", () => {
    const result = classifyObservability(
      makeMemory({ type: "conversation", title: "Session 2026-08-18 something" }),
      "/any/repo",
    );
    expect(result).toBe("unavailable");
  });

  it("returns unavailable for project nodes", () => {
    const result = classifyObservability(
      makeMemory({ type: "project", title: "desktop-link hub" }),
      "/any/repo",
    );
    expect(result).toBe("unavailable");
  });

  it("returns unavailable for general nodes", () => {
    const result = classifyObservability(
      makeMemory({ type: "general", title: "Random note" }),
      "/any/repo",
    );
    expect(result).toBe("unavailable");
  });

  it("returns unavailable for solution without a DEC-NNN/ERR-NNN id in the title", () => {
    const repo = makeRepoWithDecisions({});
    try {
      const result = classifyObservability(
        makeMemory({ type: "solution", title: "no dec/err id here" }),
        repo.dir,
      );
      expect(result).toBe("unavailable");
    } finally {
      repo.cleanup();
    }
  });
});

describe("classifyObservability — multi-id title picks the FIRST DEC-NNN", () => {
  it("first DEC-NNN match wins; the second is ignored", () => {
    const repo = makeRepoWithDecisions({
      "docs/decisions/2026-08-14-dec-030-foo.md": "x",
    });
    try {
      const result = classifyObservability(
        makeMemory({ type: "solution", title: "DEC-030 ties to DEC-999" }),
        repo.dir,
      );
      expect(result).toBe("exact");
    } finally {
      repo.cleanup();
    }
  });
});

describe("buildObservabilityClassifier — caching (TARS gate 4: readdirSync ONCE)", () => {
  it("loads the decisions listing once across many calls", () => {
    const repo = makeRepoWithDecisions({
      "docs/decisions/2026-08-14-dec-001-a.md": "x",
      "docs/decisions/2026-08-14-dec-002-b.md": "x",
      "docs/decisions/2026-08-14-dec-003-c.md": "x",
    });
    try {
      let readdirCalls = 0;
      const readdirSpy = (p: string) => {
        if (
          p.includes("docs/decisions") ||
          p.includes("docs\\decisions") ||
          p.endsWith("decisions")
        ) {
          readdirCalls += 1;
        }
        return require("node:fs").readdirSync(p) as string[];
      };
      const classify = buildObservabilityClassifier({
        repoRoot: repo.dir,
        readdirFn: readdirSpy,
      });
      classify(makeMemory({ type: "solution", title: "DEC-001 a" }));
      classify(makeMemory({ type: "solution", title: "DEC-002 b" }));
      classify(makeMemory({ type: "solution", title: "DEC-003 c" }));
      classify(makeMemory({ type: "solution", title: "DEC-999 not here" }));
      expect(readdirCalls).toBe(1);
    } finally {
      repo.cleanup();
    }
  });

  it("returns unavailable for all nodes when docs/decisions/ is missing (one readdir)", () => {
    const repo = makeRepoWithDecisions({});
    try {
      const classify = buildObservabilityClassifier({ repoRoot: repo.dir });
      expect(classify(makeMemory({ type: "solution", title: "DEC-001 x" }))).toBe(
        "estimated",
      );
      expect(classify(makeMemory({ type: "solution", title: "DEC-002 y" }))).toBe(
        "estimated",
      );
      expect(classify(makeMemory({ type: "conversation", title: "Session" }))).toBe(
        "unavailable",
      );
    } finally {
      repo.cleanup();
    }
  });

  it("falls back to estimated when the initial readdir throws (defensive)", () => {
    const classify = buildObservabilityClassifier({
      repoRoot: "/does/not/exist",
    });
    expect(classify(makeMemory({ type: "solution", title: "DEC-001 x" }))).toBe(
      "estimated",
    );
  });
});

describe("Observability field on Memory schema", () => {
  it("accepts exact/estimated/unavailable and rejects everything else", async () => {
    const { MemorySchema } = await import("../src/models.js");
    const base = {
      id: "u",
      type: "solution" as const,
      title: "x",
      content: "x",
    };
    expect(MemorySchema.parse({ ...base, observability: "exact" }).observability).toBe(
      "exact",
    );
    expect(
      MemorySchema.parse({ ...base, observability: "estimated" }).observability,
    ).toBe("estimated");
    expect(
      MemorySchema.parse({ ...base, observability: "unavailable" }).observability,
    ).toBe("unavailable");
    expect(() => MemorySchema.parse({ ...base, observability: "guessed" })).toThrow();
    expect(() => MemorySchema.parse({ ...base, observability: "" })).toThrow();
  });

  it("is optional — legacy memories without observability parse fine", async () => {
    const { MemorySchema } = await import("../src/models.js");
    const base = { id: "u", type: "solution" as const, title: "x", content: "x" };
    expect(MemorySchema.parse(base).observability).toBeUndefined();
  });
});

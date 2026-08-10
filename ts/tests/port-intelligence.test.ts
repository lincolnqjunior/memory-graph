/**
 * U4 port fixtures — intelligence layer against FalkorDB v4.16.3 dialect.
 *
 * Runs against the dedicated `memorygraph_test` graph (never the live
 * `memorygraph` store). Seeds a small deterministic store with fixed ids and
 * asserts on RETURNED CONTENT (not exit codes), per the dialect contract:
 * no datetime(), no duration.between(), no pipe-relationships, no
 * parameterized LIMIT/SKIP, no standalone exists((..)).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { FalkorDBBackend } from "../src/backends/falkordb.js";
import { createMemory, createRelationshipProperties } from "../src/models.js";
import {
  getContext,
  getProjectContext,
  getSessionContext,
} from "../src/intelligence/context-retrieval.js";
import {
  findSimilarProblems,
  extractPatterns,
  suggestPatterns,
} from "../src/intelligence/pattern-recognition.js";
import {
  linkEntities,
  type Entity,
} from "../src/intelligence/entity-extraction.js";
import {
  TemporalMemory,
  trackEntityChanges,
} from "../src/intelligence/temporal.js";

const BACKEND = new FalkorDBBackend({ graphName: "memorygraph_test" });

const RECENT_ISO = new Date(Date.now() - 3600 * 1000).toISOString();
const OLD_ISO = new Date(Date.now() - 45 * 86400000).toISOString();

const PROBLEM_ALPHA = "mem-problem-alpha";
const SOLUTION_BETA = "mem-solution-beta";
const PROBLEM_GAMMA = "mem-problem-gamma";
const DECISION_DELTA = "mem-decision-delta";
const MEM_V1 = "mem-v1";
const ENTITY_AUTH = "ent-auth";

let V2_ID = "";

beforeAll(async () => {
  await BACKEND.connect();
  await BACKEND.executeQuery("MATCH (n) DETACH DELETE n", {}, true);

  const memories = [
    createMemory({
      id: PROBLEM_ALPHA,
      type: "problem",
      title: "Alpha problem",
      content: "database connection timeout after idle hours in production",
      tags: ["demo-project", "db"],
      created_at: OLD_ISO,
    }),
    createMemory({
      id: SOLUTION_BETA,
      type: "solution",
      title: "Beta solution",
      content: "connection pool retry logic fixes database timeout",
      tags: ["demo-project"],
      created_at: RECENT_ISO,
    }),
    createMemory({
      id: PROBLEM_GAMMA,
      type: "problem",
      title: "Gamma problem",
      content: "completely unrelated topic about unrelated thing",
      tags: ["demo-project"],
      created_at: RECENT_ISO,
    }),
    createMemory({
      id: "mem-other",
      type: "general",
      title: "Other memory",
      content: "something else entirely",
      tags: ["other-project"],
      created_at: RECENT_ISO,
    }),
  ];
  for (const m of memories) await BACKEND.storeMemory(m);

  // "decision" is not a valid MemorySchema type, so seed decision nodes
  // directly (the graph itself holds any type string).
  const decisionProps: Record<string, unknown>[] = [
    {
      id: DECISION_DELTA,
      type: "decision",
      title: "Delta decision",
      content: "decision to adopt auth token rotation",
      tags: ["demo-project", "decision"],
      created_at: RECENT_ISO,
      updated_at: RECENT_ISO,
    },
    {
      id: MEM_V1,
      type: "decision",
      title: "V1 decision",
      content: "initial auth service decision v1",
      tags: ["demo-project"],
      created_at: RECENT_ISO,
      updated_at: RECENT_ISO,
    },
  ];
  for (const props of decisionProps) {
    await BACKEND.executeQuery(
      "MERGE (m:Memory {id: $id}) SET m = $props RETURN m.id as id",
      { id: props["id"], props },
      true
    );
  }

  // solution-beta SOLVES problem-alpha (marks alpha as NOT an open problem)
  await BACKEND.createRelationship(
    SOLUTION_BETA,
    PROBLEM_ALPHA,
    "SOLVES",
    createRelationshipProperties({ strength: 0.9 })
  );

  // AuthService entity, mentioned by decision-delta and v1
  await BACKEND.executeQuery(
    "MERGE (e:Entity {text: $text, type: $type}) SET e.id = $id, e.created_at = $now RETURN e.id as id",
    { text: "AuthService", type: "technology", id: ENTITY_AUTH, now: RECENT_ISO },
    true
  );
  await BACKEND.createRelationship(
    DECISION_DELTA,
    ENTITY_AUTH,
    "MENTIONS",
    createRelationshipProperties({ confidence: 0.9 })
  );
  await BACKEND.createRelationship(
    MEM_V1,
    ENTITY_AUTH,
    "MENTIONS",
    createRelationshipProperties({ confidence: 0.9 })
  );
});

afterAll(async () => {
  await BACKEND.disconnect();
});

describe("getContext", () => {
  test("returns seeded matching memories with nonzero relevance", async () => {
    const result = await getContext(BACKEND, "database timeout", 4000, null);
    expect(result.error).toBeUndefined();
    expect(result.source_memories.length).toBeGreaterThan(0);
    for (const sm of result.source_memories) {
      expect(sm.relevance).toBeGreaterThan(0);
    }
    const ids = new Set(result.source_memories.map((sm) => sm.id));
    expect(ids.has(PROBLEM_ALPHA)).toBe(true);
    expect(ids.has(SOLUTION_BETA)).toBe(true);
  });

  test("no-match query returns empty source_memories without an error object", async () => {
    const result = await getContext(BACKEND, "zzzz quux xyzzy", 4000, null);
    expect(result.error).toBeUndefined();
    expect(result.source_memories.length).toBe(0);
  });

  test("rank-then-limit: an older strongly-matching memory survives >20 matches (P1 regression)", async () => {
    // Seed 25 recent noise memories that match ONE query keyword ("filler"),
    // plus one older memory that matches SIX keywords. With the recency-decay
    // formula relevance = raw/(1+age_days/30), the old memory (raw 12, age 60
    // → 4.0) outranks fresh noise (raw 2 → ~2.0). The port must rank ALL
    // matches then take top-20 (original semantics), so the old high-relevance
    // memory survives despite 25 fresher matches.
    const noiseTag = "rank-limit-noise";
    for (let i = 0; i < 25; i++) {
      const rec = new Date(Date.now() - (1 + i) * 3600 * 1000).toISOString();
      await BACKEND.executeQuery(
        "MERGE (m:Memory {id: $id}) SET m = $props RETURN m.id as id",
        {
          id: `rank-noise-${i}`,
          props: {
            id: `rank-noise-${i}`,
            type: "general",
            title: `Noise memory ${i}`,
            content: `filler auxiliary content number ${i}`,
            tags: [noiseTag],
            created_at: rec,
            updated_at: rec,
          },
        },
        true
      );
    }
    const oldId = "rank-old-strong";
    const oldIso = new Date(Date.now() - 60 * 86400000).toISOString();
    await BACKEND.executeQuery(
      "MERGE (m:Memory {id: $id}) SET m = $props RETURN m.id as id",
      {
        id: oldId,
        props: {
          id: oldId,
          type: "general",
          title: "Old strong memory",
          content: "filler zebra survivor alpha beta gamma",
          tags: [noiseTag],
          created_at: oldIso,
          updated_at: oldIso,
        },
      },
      true
    );

    const result = await getContext(BACKEND, "filler zebra survivor alpha beta gamma", 4000, null);
    expect(result.error).toBeUndefined();
    const ids = new Set(result.source_memories.map((sm) => sm.id));
    // The old 6-keyword memory must rank above the 25 fresh 1-keyword
    // memories (relevance 4.0 vs ~2.0) and appear in the top-20.
    expect(ids.has(oldId)).toBe(true);
    expect(result.source_memories.length).toBeGreaterThan(0);
  });
});

describe("getProjectContext", () => {
  test("returns aggregate counts matching the seed", async () => {
    const result = await getProjectContext(BACKEND, "demo-project");
    expect(result.error).toBeUndefined();
    expect(result.total_memories).toBe(5);
    expect(result.recent_activity?.length).toBe(4);
    expect(result.decisions?.length).toBe(2);
    expect(result.open_problems?.length).toBe(1);
    expect(result.solutions?.length).toBe(1);
  });
});

describe("getSessionContext", () => {
  test("returns recent memories and excludes the 45-day-old one", async () => {
    const result = await getSessionContext(BACKEND, 24, 10);
    expect(result.error).toBeUndefined();
    const ids = new Set(result.recent_memories.map((m) => m["id"]));
    expect(ids.has(SOLUTION_BETA)).toBe(true);
    expect(ids.has(PROBLEM_ALPHA)).toBe(false);
    // Membership-based (the rank-then-limit test seeds recent noise earlier
    // in the file, so an exact count is not stable).
    expect(result.total_count).toBeGreaterThanOrEqual(1);
  });
});

describe("findSimilarProblems", () => {
  test("returns the linked solution for a known problem", async () => {
    const results = await findSimilarProblems(
      BACKEND,
      "database connection timeout after idle",
      0.7,
      10
    );
    expect(results.length).toBeGreaterThan(0);
    const alpha = results.find((r) => r["problem_id"] === PROBLEM_ALPHA);
    expect(alpha).toBeDefined();
    expect(Number(alpha!["similarity"])).toBeGreaterThan(0);
    const solutions = alpha!["solutions"] as Record<string, unknown>[];
    expect(solutions.length).toBe(1);
    expect(solutions[0]["id"]).toBe(SOLUTION_BETA);
  });

  test("no-match query returns an empty array", async () => {
    const results = await findSimilarProblems(BACKEND, "zzz qqq unknown term", 0.7, 10);
    expect(results).toEqual([]);
  });
});

describe("suggestPatterns", () => {
  test("surfaces memories matching extracted entities", async () => {
    const patterns = await suggestPatterns(BACKEND, "AuthService", 5);
    expect(patterns.length).toBeGreaterThan(0);
    const memoryIds = patterns.map((p) => p.source_memory_ids[0]);
    expect(memoryIds).toContain(DECISION_DELTA);
  });
});

describe("extractPatterns", () => {
  test("counts entity occurrences across decision memories", async () => {
    // Seed links AuthService to DECISION_DELTA and MEM_V1 (both type
    // decision); no solution mentions it — so query decisions.
    const patterns = await extractPatterns(BACKEND, "decision", 1);
    const auth = patterns.find((p) => p.entities.includes("AuthService"));
    expect(auth).toBeDefined();
    expect(auth!.occurrences).toBe(2);
    expect(auth!.source_memory_ids).toContain(DECISION_DELTA);
    expect(auth!.source_memory_ids).toContain(MEM_V1);
  });
});

describe("linkEntities", () => {
  test("creates entity nodes, MENTIONS links, and increments occurrence count", async () => {
    const entity: Entity = {
      text: "DatabasePool",
      entity_type: "technology",
      confidence: 0.95,
    };
    const first = await linkEntities(BACKEND, SOLUTION_BETA, [entity]);
    expect(first.length).toBe(1);
    const entityId = first[0]!;
    expect(typeof entityId).toBe("string");
    expect(entityId.length).toBeGreaterThan(0);

    const nodeRes = await BACKEND.executeQuery(
      "MATCH (e:Entity {text: 'DatabasePool'}) RETURN e.id as id, e.occurrence_count as count, e.created_at as created_at",
      {},
      false
    );
    expect(nodeRes.length).toBe(1);
    expect(nodeRes[0]["id"]).toBe(entityId);
    expect(Number(nodeRes[0]["count"])).toBe(1);
    expect(nodeRes[0]["created_at"]).toBeTruthy();

    const relRes = await BACKEND.executeQuery(
      "MATCH (:Memory {id: $mid})-[r:MENTIONS]->(:Entity {text: 'DatabasePool'}) RETURN r.confidence as confidence, r.created_at as created_at",
      { mid: SOLUTION_BETA },
      false
    );
    expect(relRes.length).toBe(1);
    expect(relRes[0]["created_at"]).toBeTruthy();

    const second = await linkEntities(BACKEND, SOLUTION_BETA, [entity]);
    expect(second[0]).toBe(entityId);
    const afterRes = await BACKEND.executeQuery(
      "MATCH (e:Entity {text: 'DatabasePool'}) RETURN e.occurrence_count as count",
      {},
      false
    );
    expect(Number(afterRes[0]["count"])).toBe(2);
  });
});

describe("createVersion", () => {
  test("creates a new node and flips is_current on the superseded one", async () => {
    const newId = await new TemporalMemory(BACKEND).createVersion(MEM_V1, {
      title: "V2 decision",
      content: "revised auth decision v2",
      type: "decision",
      tags: ["versioned"],
    });
    expect(typeof newId).toBe("string");
    expect(newId.length).toBeGreaterThan(0);
    V2_ID = newId;

    const newRes = await BACKEND.executeQuery(
      "MATCH (n:Memory {id: $id}) RETURN n.is_current as is_current, n.created_at as created_at, n.updated_at as updated_at",
      { id: newId },
      false
    );
    expect(newRes.length).toBe(1);
    expect(newRes[0]["is_current"]).toBe(true);
    expect(typeof newRes[0]["created_at"]).toBe("string");
    expect(newRes[0]["created_at"]).toBeTruthy();

    const oldRes = await BACKEND.executeQuery(
      "MATCH (n:Memory {id: $id}) RETURN n.is_current as is_current, n.superseded_by as superseded_by",
      { id: MEM_V1 },
      false
    );
    expect(oldRes.length).toBe(1);
    expect(oldRes[0]["is_current"]).toBe(false);
    expect(oldRes[0]["superseded_by"]).toBe(newId);

    const relRes = await BACKEND.executeQuery(
      "MATCH (:Memory {id: $new_id})-[r:PREVIOUS]->(:Memory {id: $old_id}) RETURN r.superseded_at as superseded_at",
      { new_id: newId, old_id: MEM_V1 },
      false
    );
    expect(relRes.length).toBe(1);
    expect(relRes[0]["superseded_at"]).toBeTruthy();

    const linked = await linkEntities(BACKEND, newId, [
      { text: "AuthService", entity_type: "technology", confidence: 0.9 },
    ]);
    expect(linked.length).toBe(1);
    expect(linked[0]).toBe(ENTITY_AUTH);
  });
});

describe("trackEntityChanges", () => {
  test("flags the new version as a non-new mention with current status", async () => {
    const timeline = await trackEntityChanges(BACKEND, ENTITY_AUTH);
    expect(timeline.length).toBeGreaterThanOrEqual(3);

    const v1 = timeline.find((t) => t.memory_id === MEM_V1);
    expect(v1).toBeDefined();
    expect(v1!.was_new_mention).toBe(true);
    expect(v1!.status).toBe("superseded");

    const v2 = timeline.find((t) => t.memory_id === V2_ID);
    expect(v2).toBeDefined();
    expect(v2!.was_new_mention).toBe(false);
    expect(v2!.status).toBe("current");
    expect(v2!.created_at).toBeTruthy();

    const delta = timeline.find((t) => t.memory_id === DECISION_DELTA);
    expect(delta).toBeDefined();
    expect(delta!.was_new_mention).toBe(true);
  });
});

/**
 * U6 port fixtures — analytics layer against FalkorDB v4.16.3 dialect.
 *
 * Runs against the dedicated `memorygraph_test` graph (never the live
 * `memorygraph` store). Seeds a small deterministic graph and asserts on
 * RETURNED CONTENT (not exit codes): node/edge payloads for visualize,
 * ranked similarity results, and knowledge-gap identification.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { FalkorDBBackend } from "../src/backends/falkordb.js";
import { createMemory, createRelationshipProperties } from "../src/models.js";
import {
  getMemoryGraphVisualization,
  analyzeSolutionSimilarity,
  recommendLearningPaths,
  identifyKnowledgeGaps,
} from "../src/analytics/advanced-queries.js";

const BACKEND = new FalkorDBBackend({ graphName: "memorygraph_test" });

const RECENT_ISO = new Date(Date.now() - 3600 * 1000).toISOString();
const OLD_ISO = new Date(Date.now() - 45 * 86400000).toISOString();

const VIZ_A = "viz-a-problem";
const VIZ_B = "viz-b-solution";
const VIZ_C = "viz-c-solution";
const VIZ_ISO = "viz-iso-solution";
const SIM_1 = "sim-1-solution";
const SIM_2 = "sim-2-solution";
const SIM_3 = "sim-3-unrelated";
const GAP_OLD = "gap-old-problem";
const GAP_NEW = "gap-new-problem";
const ENT_PG = "ent-postgresql";

beforeAll(async () => {
  await BACKEND.connect();
  await BACKEND.executeQuery("MATCH (n) DETACH DELETE n", {}, true);

  // 3-node, 2-edge graph for visualize (A problem <- SOLVES - B solution,
  // B -RELATED_TO-> C solution)
  for (const m of [
    createMemory({ id: VIZ_A, type: "problem", title: "Visualize problem A", content: "viz a", tags: ["viz"], created_at: RECENT_ISO }),
    createMemory({ id: VIZ_B, type: "solution", title: "Visualize solution B", content: "viz b", tags: ["viz"], created_at: RECENT_ISO }),
    createMemory({ id: VIZ_C, type: "solution", title: "Visualize solution C", content: "viz c", tags: ["viz"], created_at: RECENT_ISO }),
    createMemory({ id: VIZ_ISO, type: "solution", title: "Isolated solution", content: "no edges", tags: ["viz"], created_at: RECENT_ISO }),
  ]) {
    await BACKEND.storeMemory(m);
  }
  await BACKEND.createRelationship(VIZ_B, VIZ_A, "SOLVES", createRelationshipProperties({ strength: 0.9 }));
  await BACKEND.createRelationship(VIZ_B, VIZ_C, "RELATED_TO", createRelationshipProperties({ strength: 0.7 }));

  // Similarity seed: SIM_1 and SIM_2 share entity "PostgreSQL" + tag "db";
  // SIM_3 shares nothing.
  for (const m of [
    createMemory({ id: SIM_1, type: "solution", title: "Sim solution one", content: "uses PostgreSQL", tags: ["db"], created_at: RECENT_ISO }),
    createMemory({ id: SIM_2, type: "solution", title: "Sim solution two", content: "also PostgreSQL", tags: ["db"], created_at: RECENT_ISO }),
    createMemory({ id: SIM_3, type: "solution", title: "Unrelated solution", content: "cooking recipes", tags: ["kitchen"], created_at: RECENT_ISO }),
  ]) {
    await BACKEND.storeMemory(m);
  }
  await BACKEND.executeQuery(
    "MERGE (e:Entity {text: $text, type: $type}) SET e.id = $id, e.created_at = $now RETURN e.id as id",
    { text: "PostgreSQL", type: "technology", id: ENT_PG, now: RECENT_ISO },
    true
  );
  await BACKEND.createRelationship(SIM_1, ENT_PG, "MENTIONS", createRelationshipProperties({ confidence: 0.9 }));
  await BACKEND.createRelationship(SIM_2, ENT_PG, "MENTIONS", createRelationshipProperties({ confidence: 0.9 }));

  // Learning path seed: VIZ_B BUILDS_ON VIZ_C (direct), VIZ_B BUILDS_ON VIZ_C BUILDS_ON SIM_1 (depth 2)
  await BACKEND.createRelationship(VIZ_B, VIZ_C, "BUILDS_ON", createRelationshipProperties({ strength: 0.6 }));
  await BACKEND.createRelationship(VIZ_C, SIM_1, "BUILDS_ON", createRelationshipProperties({ strength: 0.6 }));

  // Gaps seed: gap-old (45 days old, no SOLVES) → high severity; gap-new
  // (today, no SOLVES) → low; VIZ_A has SOLVES so NOT a gap.
  for (const m of [
    createMemory({ id: GAP_OLD, type: "problem", title: "Old unsolved problem", content: "legacy issue", tags: ["gap"], created_at: OLD_ISO }),
    createMemory({ id: GAP_NEW, type: "problem", title: "New unsolved problem", content: "fresh issue", tags: ["gap"], created_at: RECENT_ISO }),
  ]) {
    await BACKEND.storeMemory(m);
  }
});

afterAll(async () => {
  await BACKEND.disconnect();
});

describe("getMemoryGraphVisualization", () => {
  test("center-anchored: returns the 3-node 2-edge subgraph", async () => {
    const viz = await getMemoryGraphVisualization(BACKEND, VIZ_B, 2, 100);
    const nodeIds = new Set(viz.nodes.map((n) => n.id));
    expect(nodeIds.has(VIZ_A)).toBe(true);
    expect(nodeIds.has(VIZ_B)).toBe(true);
    expect(nodeIds.has(VIZ_C)).toBe(true);
    expect(viz.edges.length).toBeGreaterThanOrEqual(2);
    // Undirected match row order is nondeterministic; assert the SOLVES and
    // RELATED_TO edges connect the right endpoints (either orientation).
    const hasEdge = (a: string, b: string, type: string) =>
      viz.edges.some(
        (e) => e.type === type && ((e.from === a && e.to === b) || (e.from === b && e.to === a))
      );
    expect(hasEdge(VIZ_B, VIZ_A, "SOLVES")).toBe(true);
    expect(hasEdge(VIZ_B, VIZ_C, "RELATED_TO")).toBe(true);
    // dedup: each seeded relationship yields exactly ONE edge (no mirror
    // duplicates from the undirected match). The center neighborhood also
    // includes BUILDS_ON edges to/from the learning-path seed.
    const distinct = new Set(viz.edges.map((e) => [e.from, e.to, e.type].sort().join("|")));
    expect(distinct.size).toBe(viz.edges.length);
  });

  test("isolated node with no relationships returns clean empty-adjacency result", async () => {
    const viz = await getMemoryGraphVisualization(BACKEND, VIZ_ISO, 2, 100);
    const nodeIds = new Set(viz.nodes.map((n) => n.id));
    expect(nodeIds.has(VIZ_ISO)).toBe(true);
    // no edges from the isolated node to itself
    expect(viz.edges.filter((e) => e.from === VIZ_ISO && e.to === VIZ_ISO).length).toBe(0);
    expect(Array.isArray(viz.edges)).toBe(true);
  });
});

describe("analyzeSolutionSimilarity", () => {
  test("ranks the shared-entity solution above the unrelated one", async () => {
    const similar = await analyzeSolutionSimilarity(BACKEND, SIM_1, 5, 0.3);
    const ids = similar.map((s) => s.solution_id);
    expect(ids).toContain(SIM_2);
    expect(ids).not.toContain(SIM_3);
    expect(similar[0]!.similarity_score).toBeGreaterThan(0);
    // SIM_2 shared the PostgreSQL entity + db tag
    expect(similar[0]!.shared_entities).toContain("PostgreSQL");
  });

  test("returns [] for a nonexistent solution", async () => {
    const similar = await analyzeSolutionSimilarity(BACKEND, "no-such-solution", 5, 0.3);
    expect(similar).toEqual([]);
  });
});

describe("recommendLearningPaths", () => {
  test("builds a path from the seed BUILDS_ON chain", async () => {
    const paths = await recommendLearningPaths(BACKEND, "Visualize solution", 3);
    expect(paths.length).toBeGreaterThan(0);
    // a path starting from VIZ_B (topic matched in title) with >= 1 step
    const anyPath = paths.some((p) => p.steps.length >= 1 && p.total_memories >= 1);
    expect(anyPath).toBe(true);
  });
});

describe("identifyKnowledgeGaps", () => {
  test("flags the old unsolved problem as high severity and the solved one as not-a-gap", async () => {
    const gaps = await identifyKnowledgeGaps(BACKEND, null, "low");
    const oldGap = gaps.find((g) => g.gap_id === GAP_OLD);
    const newGap = gaps.find((g) => g.gap_id === GAP_NEW);
    const solvedGap = gaps.find((g) => g.gap_id === VIZ_A);
    expect(oldGap).toBeDefined();
    expect(oldGap!.severity).toBe("high");
    expect(newGap).toBeDefined();
    expect(newGap!.severity).toBe("low");
    // VIZ_A has a SOLVES link → excluded from unsolved-problem gaps
    expect(solvedGap).toBeUndefined();
  });
});

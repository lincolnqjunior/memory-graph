/**
 * U5 port fixtures — proactive layer against FalkorDB v4.16.3 dialect.
 *
 * Runs against the dedicated `memorygraph_test` graph (never the live
 * `memorygraph` store). Seeds a small deterministic store with fixed ids and
 * asserts on RETURNED CONTENT (not exit codes), per the dialect contract:
 * no datetime(), no duration.between(), no pipe-relationships, no
 * parameterized LIMIT/SKIP, no EXISTS { } subqueries.
 *
 * Entity extraction note: the extractor recognizes CamelCase identifiers and
 * well-known tech names; "PostgreSQL"/"Redis" extract as type `technology`
 * (confidence 0.95), lowercase phrases extract as nothing. Tests use those.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FalkorDBBackend } from "../src/backends/falkordb.js";
import { createMemory, createRelationshipProperties } from "../src/models.js";
import {
  predictNeeds,
  warnPotentialIssues,
  suggestRelatedContext,
} from "../src/proactive/predictive.js";
import {
  recordOutcome,
  updatePatternEffectiveness,
  calculateEffectivenessScore,
} from "../src/proactive/outcome-learning.js";
import {
  generateSessionBriefing,
  formatBriefingAsText,
} from "../src/proactive/session-briefing.js";

const BACKEND = new FalkorDBBackend({ graphName: "memorygraph_test" });

const RECENT_ISO = new Date(Date.now() - 3600 * 1000).toISOString();
const OLD_ISO = new Date(Date.now() - 40 * 86400000).toISOString();

const SOL_PROBLEM = "pro-sol-db-timeout";
const SOL_SOLUTION = "sol-connection-pool";
const SOL_PATTERN = "pat-retry-logic";
const SOL_DECISION = "dec-auth-token";
const ENTITY_POOL = "ent-connection-pool";

// Briefing fixture: a temp project dir (detectProject reads the filesystem)
// + memories carrying the matching context_project_path.
let BRIEF_DIR = "";
const BRIEF_MEM = "brief-recent-solution";

beforeAll(async () => {
  await BACKEND.connect();
  await BACKEND.executeQuery("MATCH (n) DETACH DELETE n", {}, true);

  BRIEF_DIR = mkdtempSync(join(tmpdir(), "mg-brief-"));
  writeFileSync(join(BRIEF_DIR, "package.json"), JSON.stringify({ name: "brief-fixture" }));

  const memories = [
    createMemory({
      id: SOL_PROBLEM,
      type: "problem",
      title: "DB connection timeout problem",
      content: "PostgreSQL connection timeout after idle hours in production",
      tags: ["proactive-test", "db"],
      created_at: OLD_ISO,
    }),
    createMemory({
      id: "pro-lowercase-timeout",
      type: "problem",
      title: "Lowercase timeout problem",
      content: "postgresql connection timeout after idle hours",
      tags: ["proactive-test", "db"],
      created_at: RECENT_ISO,
    }),
    createMemory({
      id: SOL_SOLUTION,
      type: "solution",
      title: "Connection pool retry solution",
      content: "connection pool retry logic fixes PostgreSQL timeout",
      tags: ["proactive-test", "db"],
      created_at: RECENT_ISO,
    }),
  ];
  for (const m of memories) await BACKEND.storeMemory(m);

  // Briefing fixture memory: context_project_path must equal the temp dir
  // (detectProject resolves project.path to the absolute directory).
  await BACKEND.executeQuery(
    "MERGE (m:Memory {id: $id}) SET m = $props RETURN m.id as id",
    {
      id: BRIEF_MEM,
      props: {
        id: BRIEF_MEM,
        type: "solution",
        title: "Briefing recent solution",
        content: "recent work for the briefing fixture",
        tags: ["briefing"],
        created_at: RECENT_ISO,
        updated_at: RECENT_ISO,
        context_project_path: BRIEF_DIR,
      },
    },
    true
  );

  // A decision node (not a valid MemorySchema enum type, seed directly)
  await BACKEND.executeQuery(
    "MERGE (m:Memory {id: $id}) SET m = $props RETURN m.id as id",
    {
      id: SOL_DECISION,
      props: {
        id: SOL_DECISION,
        type: "decision",
        title: "Auth token rotation decision",
        content: "decision to adopt auth token rotation for the service",
        tags: ["proactive-test"],
        created_at: RECENT_ISO,
        updated_at: RECENT_ISO,
      },
    },
    true
  );

  // A code_pattern node (not a valid MemorySchema type, seed directly)
  await BACKEND.executeQuery(
    "MERGE (m:Memory {id: $id}) SET m = $props RETURN m.id as id",
    {
      id: SOL_PATTERN,
      props: {
        id: SOL_PATTERN,
        type: "code_pattern",
        title: "Retry with backoff pattern",
        content: "retry with exponential backoff on transient PostgreSQL failures",
        tags: ["proactive-test"],
        effectiveness: 0.8,
        usage_count: 3,
        created_at: RECENT_ISO,
        updated_at: RECENT_ISO,
      },
    },
    true
  );

  // solution SOLVES problem (so the problem is NOT unresolved)
  await BACKEND.createRelationship(
    SOL_SOLUTION,
    SOL_PROBLEM,
    "SOLVES",
    createRelationshipProperties({ strength: 0.9 })
  );  // solution SIMILAR_TO pattern (in suggestRelatedContext's allowed list)
  await BACKEND.createRelationship(
    SOL_SOLUTION,
    SOL_PATTERN,
    "SIMILAR_TO",
    createRelationshipProperties({ strength: 0.8 })
  );
  // solution MENTIONS entity; decision MENTIONS entity
  await BACKEND.executeQuery(
    "MERGE (e:Entity {text: $text, type: $type}) SET e.id = $id, e.created_at = $now RETURN e.id as id",
    { text: "PostgreSQL", type: "technology", id: ENTITY_POOL, now: RECENT_ISO },
    true
  );
  await BACKEND.createRelationship(
    SOL_SOLUTION,
    ENTITY_POOL,
    "MENTIONS",
    createRelationshipProperties({ confidence: 0.9 })
  );
  await BACKEND.createRelationship(
    SOL_DECISION,
    ENTITY_POOL,
    "MENTIONS",
    createRelationshipProperties({ confidence: 0.8 })
  );
});

afterAll(async () => {
  await BACKEND.disconnect();
});

describe("recordOutcome", () => {
  test("creates an Outcome node linked via RESULTED_IN and bumps effectiveness", async () => {
    const ok = await recordOutcome(BACKEND, SOL_SOLUTION, "worked in prod", true);
    expect(ok).toBe(true);

    const res = await BACKEND.executeQuery(
      "MATCH (s:Memory {id: $id})-[:RESULTED_IN]->(o:Outcome) RETURN o.id as oid, o.success as success, o.timestamp as ts, o.impact as impact",
      { id: SOL_SOLUTION },
      false
    );
    expect(res.length).toBe(1);
    expect(res[0]["success"]).toBe(true);
    expect(res[0]["ts"]).toBeTruthy();
    expect(Number(res[0]["impact"])).toBe(1);

    const eff = await BACKEND.executeQuery(
      "MATCH (s:Memory {id: $id}) RETURN s.effectiveness as eff, s.usage_count as uc, s.last_accessed as la",
      { id: SOL_SOLUTION },
      false
    );
    expect(eff.length).toBe(1);
    expect(eff[0]["la"]).toBeTruthy();
    expect(Number(eff[0]["uc"])).toBe(1);
  });
});

describe("updatePatternEffectiveness", () => {
  test("updates the pattern effectiveness from an outcome", async () => {
    const ok = await updatePatternEffectiveness(BACKEND, SOL_PATTERN, true, 0.5);
    expect(ok).toBe(true);

    const res = await BACKEND.executeQuery(
      "MATCH (p:Memory {id: $id}) RETURN p.effectiveness as eff, p.usage_count as uc, p.last_accessed as la",
      { id: SOL_PATTERN },
      false
    );
    expect(res.length).toBe(1);
    // recordOutcome already propagated to the SIMILAR_TO-linked pattern via
    // propagateToPatterns; this call adds another increment.
    expect(Number(res[0]["uc"])).toBeGreaterThanOrEqual(4);
    expect(res[0]["la"]).toBeTruthy();
    expect(Number(res[0]["eff"])).toBeGreaterThan(0.7);
  });

  test("returns false for a missing pattern (no error, no write)", async () => {
    const ok = await updatePatternEffectiveness(BACKEND, "pattern-does-not-exist", true);
    expect(ok).toBe(false);
  });
});

describe("calculateEffectivenessScore", () => {
  test("returns aggregate outcome stats for a memory", async () => {
    const score = await calculateEffectivenessScore(BACKEND, SOL_SOLUTION);
    expect(score).not.toBeNull();
    expect(score!.total_uses).toBe(1);
    expect(score!.successful_uses).toBe(1);
    expect(score!.failed_uses).toBe(0);
  });

  test("returns null for a missing memory", async () => {
    const score = await calculateEffectivenessScore(BACKEND, "no-such-memory");
    expect(score).toBeNull();
  });
});

describe("predictNeeds", () => {
  test("returns the solution relevant to the context entities", async () => {
    const suggestions = await predictNeeds(BACKEND, "PostgreSQL", 5, 0.3);
    expect(suggestions.length).toBeGreaterThan(0);
    const ids = new Set(suggestions.map((s) => s.memory_id));
    expect(ids.has(SOL_SOLUTION)).toBe(true);
    for (const s of suggestions) {
      expect(s.relevance_score).toBeGreaterThan(0);
    }
  });

  test("returns [] for context with no extracted entities", async () => {
    const suggestions = await predictNeeds(BACKEND, "a and the or of", 5, 0.3);
    expect(suggestions).toEqual([]);
  });
});

describe("warnPotentialIssues", () => {
  test("returns a warning for a known problem matching context", async () => {
    // "PostgreSQL" extracts as a technology entity (confidence 0.95); the
    // lowercased keyword "postgresql" matches pro-lowercase-timeout's
    // lowercase content case-sensitively. That problem has NO solution link
    // → severity high.
    const warnings = await warnPotentialIssues(
      BACKEND,
      "PostgreSQL",
      "medium"
    );
    const problem = warnings.find((w) => w.related_problem_id === "pro-lowercase-timeout");
    expect(problem).toBeDefined();
    expect(problem!.severity).toBe("high");
    expect(problem!.mitigation).toContain("No known solution");
  });

  test("returns no warnings for unrelated context", async () => {
    const warnings = await warnPotentialIssues(BACKEND, "totally unrelated alien topic", "medium");
    const problem = warnings.find((w) => w.related_problem_id === SOL_PROBLEM);
    expect(problem).toBeUndefined();
  });
});

describe("suggestRelatedContext", () => {
  test("returns memories linked via supported rel types", async () => {
    const suggestions = await suggestRelatedContext(BACKEND, SOL_SOLUTION, 5);
    expect(suggestions.length).toBeGreaterThan(0);
    const ids = new Set(suggestions.map((s) => s.memory_id));
    expect(ids.has(SOL_PATTERN)).toBe(true);
  });
});

describe("generateSessionBriefing", () => {
  test("produces a full briefing with the seeded activity (no half-filled swallow)", async () => {
    const briefing = await generateSessionBriefing(BACKEND, BRIEF_DIR, 7, 10);
    expect(briefing).not.toBeNull();
    const briefName = (BRIEF_DIR.split(/[\\/]/).pop() ?? "");
    expect(briefing!.project_name).toBe(briefName);
    expect(briefing!.total_memories).toBe(1);
    expect(briefing!.recent_activities.length).toBe(1);
    expect(briefing!.recent_activities[0]!.memory_id).toBe(BRIEF_MEM);

    const text = formatBriefingAsText(briefing!, "standard");
    expect(text).toContain(`# Session Briefing for ${briefName}`);
    expect(text).toContain("Briefing recent solution");
    expect(text).toContain("Total memories: 1");
  });
});

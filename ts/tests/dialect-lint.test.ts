/**
 * Tests for the dialect lint (scripts/dialect-lint.ts).
 *
 * The lint is a deterministic regex scan over the ported analytical-layer
 * files for FalkorDB v4.x REJECTED Cypher constructs (datetime(), pipe-rels,
 * parameterized LIMIT, id(), duration.between, EXISTS { } subqueries). It
 * exists because `tsc`/`bun test` never see the template-literal Cypher
 * strings — the regex whitelist is the only thing that flags residual
 * rejected constructs after a port.
 *
 * These tests exercise the lint's FORBIDDEN table against known-good and
 * known-bad fixture lines, so a future port that reintroduces a rejected
 * construct fails here instead of at runtime (where executeQuery wraps the
 * error as DatabaseConnectionError and commands silently exit 0).
 */

import { describe, test, expect } from "bun:test";
import { FORBIDDEN } from "../../scripts/dialect-lint.js";

describe("dialect-lint FORBIDDEN patterns", () => {
  const flagged = (line: string): boolean =>
    FORBIDDEN.some(([re]) => {
      re.lastIndex = 0;
      return re.test(line);
    });

  test("flags datetime()", () => {
    expect(flagged("SET new.created_at = datetime(),")).toBe(true);
    expect(flagged("WHERE m.created_at >= datetime() - duration({days: 7})")).toBe(true);
  });

  test("flags duration.between()", () => {
    expect(flagged("duration.between(m.created_at, datetime()).days as age_days")).toBe(true);
  });

  test("flags parameterized LIMIT / SKIP", () => {
    expect(flagged("LIMIT $limit")).toBe(true);
    expect(flagged("SKIP $offset")).toBe(true);
    expect(flagged("LIMIT 20")).toBe(false);
    expect(flagged("SKIP 0 LIMIT 10")).toBe(false);
    // template interpolation renders to a literal integer — sanctioned form
    expect(flagged("LIMIT ${intLimit}")).toBe(false);
    expect(flagged("SKIP ${searchQuery.offset ?? 0}")).toBe(false);
  });

  test("flags EXISTS { } / NOT EXISTS { } subqueries", () => {
    expect(flagged("WHERE NOT EXISTS { MATCH (p)<-[:SOLVES]-(:Memory) }")).toBe(true);
    expect(flagged("WHERE EXISTS { MATCH (m)-[:MENTIONS]->(e:Entity) }")).toBe(true);
    expect(flagged("WHERE count { MATCH (m)-[:MENTIONS]->(e:Entity) } > 0")).toBe(true);
  });

  test("flags pipe-relationships but not list-comprehension pipes", () => {
    expect(flagged("OPTIONAL MATCH (m)-[r:SOLVES|SOLVED_BY]-(solution:Memory)")).toBe(true);
    expect(flagged("MATCH (b)<-[:RELATED_TO|SOLVES]-(a)")).toBe(true);
    expect(flagged("[:BUILDS_ON|GENERALIZES|SPECIALIZES*1..3]")).toBe(true);
    // list comprehension pipe is legal — no type-list colon form
    expect(flagged("[m2 IN collect(m) | m2.id]")).toBe(false);
    expect(flagged("any(keyword IN $keywords WHERE toLower(m.content) CONTAINS keyword)")).toBe(false);
  });

  test("flags id() function", () => {
    expect(flagged("WHERE id(e1) < id(e2)")).toBe(true);
    expect(flagged("id(rel)")).toBe(true);
    expect(flagged("related.id")).toBe(false);
  });

  test("flags startNode(rel).id", () => {
    expect(flagged("startNode(rel).id")).toBe(true);
    expect(flagged("startNode(r).id")).toBe(true);
  });

  test("passes clean lines with no rejected constructs", () => {
    const clean = [
      "MERGE (m:Memory {id: $id})",
      "SET m += $properties",
      "WHERE related.id <> start.id",
      "RETURN m.id as id, m.title as title",
      "ORDER BY m.created_at DESC",
      "SKIP 0 LIMIT 10",
      "relationships(r)[0] as rel",
      "any(e IN ['x'] WHERE exists((m)-[:MENTIONS]->(:Entity {text: e})))",
    ];
    for (const line of clean) {
      expect(flagged(line), `expected clean: ${line}`).toBe(false);
    }
  });
});

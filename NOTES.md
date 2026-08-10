# Local Fork Notes

This clone carries an **intentional local divergence** from upstream
`https://github.com/memory-graph/memory-graph` so the CLI works against a
modern FalkorDB server (v4.x, Redis 8.6.3). These are working-tree edits; do
not push them upstream.

## Divergence (6 edits in `ts/src/backends/falkordb-shared.ts`)

1. **`executeQuery` — param wrapping.**
   Upstream: `this.graph.query(query, params)`
   Forked: `this.graph.query(query, { params })`
   The bundled `falkordb` npm client (6.x) expects `graph.query(query, { params })`
   and emits the inline `CYPHER ...` parameter syntax modern FalkorDB requires.
   Without this, every write query fails with `Missing parameters`.

2. **`searchMemories` — literal `SKIP`/`LIMIT`, openCypher order.**
   Upstream: `LIMIT $limit SKIP $offset` (parameterized)
   Forked: `SKIP ${searchQuery.offset ?? 0} LIMIT ${searchQuery.limit}` (interpolated)
   Modern FalkorDB requires `LIMIT`/`SKIP` as literals **and** in `SKIP`-before-`LIMIT`
   order (it rejects `LIMIT n SKIP m` with `Invalid input 'K'`). Verified empirically
   against v4.16.3: `SKIP 0 LIMIT 10` parses; `LIMIT 10 SKIP 0` does not.
   Safe to interpolate: `limit`/`offset` are `z.number().int()`-validated in the
   query layer (see `ts/src/models.ts`), so no string-typed injection surface.

3. **`convertFalkorDBResult` — unwrap node values in dict-shaped rows.**
   Upstream: `resultList.push(this.convertFalkorDBValue(row))` — only unwraps when the
   row itself carries a top-level `properties` key.
   Forked: iterates the row's keys and calls `convertFalkorDBValue` on each value.
   falkordb-ts 6.6.2 returns rows keyed by column alias (`{ m: { id, labels, properties } }`)
   with `header: undefined`, so node-returning queries (`search`, `related`, `as-of`,
   `history`) previously handed the wrapped node to `parseMemoryFromProperties`, which
   failed validation with empty `title`/`content`. Verified against v4.16.3: without
   this unwrap, node-returning commands error; with it, they round-trip.

4. **`executeQuery` — prune `undefined` params.**
   Upstream: `this.graph.query(query, { params })` with the params passed through as-is.
   Forked: params are recursively pruned of `undefined` values first
   (`pruneUndefined`), because falkordb-ts 6.6.2 throws `Unexpected param type
   undefined` when a map value is `undefined`. Triggered by `link` without
   `--context` (the tool layer passes `context: undefined` into
   `createRelationshipProperties`). Pruning at the query chokepoint covers every
   call site.

5. **`createRelationship` — `SET r = $properties` instead of inline rel props.**
   Upstream: `CREATE (from)-[r:TYPE $properties]->(to)` (parameterized relationship
   properties).
   Forked: `CREATE (from)-[r:TYPE]->(to)` then `SET r = $properties`.
   FalkorDB v4.16.3 rejects an inlined map as relationship properties
   (`Encountered unhandled type in inlined properties`) when the map arrives via
   the `CYPHER` param header; assigning it with `SET` after `CREATE` is accepted
   (same pattern the `store` path already uses with `SET m += $properties`).
   Verified empirically against v4.16.3.

6. **`getRelatedMemories` — `relationships(r)[0]` instead of `r[0]`.**
   Upstream: `WITH DISTINCT related, r[0] as rel` on a variable-length path
   `(start)-[r*1..N]-(related)`.
   Forked: `WITH DISTINCT related, relationships(r)[0] as rel`.
   FalkorDB v4.16.3 binds `r` to a **Path**, so `r[0]` yields a Path and
   `properties(rel)` fails with `Type mismatch: expected Map, Node, Edge, List,
   or Null but was Path`. `relationships(r)[0]` extracts the first edge.
   `related`, `as-of`, and `history` CLI commands all route through this
   function, so one fix covers all three. Verified against v4.16.3.

## Re-apply reminder

After `git pull` / `git reset --hard` / `git clean`, re-apply the **six
divergences** above in `ts/src/backends/falkordb-shared.ts` (items 1–6). The
header "Divergence (2 lines...)" is stale — all six are live fork edits;
re-applying only the first two silently breaks `link` without `--context`
(item 4), relationship-typed links (item 5), and the whole related/as-of/
history family (item 6).

### Analytical-layer deviations (land inline in these files)

The analytical layer was ported to the modern FalkorDB v4.x dialect (2026-08-10,
`feat: semantic memory return` plan). Rejected upstream constructs
(`datetime()`, `duration.between()`, `EXISTS { }`/`NOT EXISTS { }` subqueries,
parameterized `LIMIT`/`SKIP`, pipe-relationships `<-[:A|B]-`, `id()`,
`startNode(rel).id`) are replaced with the v4 dialect:

- `datetime()` / `datetime($x)` → ISO-8601 string comparison against a
  TS-computed cutoff (`m.created_at >= $cutoff`) — verified lexicographic
  ordering == chronological for RFC3339 UTC strings; `timestamp()` for
  numeric now.
- `duration.between(a, b).days` → TS-side `Date.parse` arithmetic on the
  fetched ISO strings.
- `NOT EXISTS { MATCH ... }` → `NOT (n)-[:T]->(:Label)` pattern predicate
  (verified working) or `OPTIONAL MATCH` + null check. NOTE: standalone
  `exists((n)-[:T]->(..))` is ALSO rejected in v4.16.3 ("Unable to resolve
  filtered alias"); the working form is `any(x IN [...] WHERE
  exists((n)-[:T]->(..)))`.
- `LIMIT $x` / `SKIP $x` → interpolated validated integers (z-validated
  callers, same safety argument as divergence item 2).
- Pipe-rels `[r:A|B]` / `<-[:A|B]-` → split into multiple `MATCH` + `UNION`
  or a `WHERE type(r) IN [...]` chain.
- `id()` / `startNode(rel).id` → memories and relationships carry an `id`
  **property** (set by `storeMemory` / `createRelationship`); use `m.id` /
  `r.id` instead of the internal node id.
- `collect({...})` nested inside another aggregating query → compute in TS
  or split into two queries (FalkorDB: "Invalid use of aggregating function
  'collect'").

`scripts/dialect-lint.ts` scans the ported files for residual rejected
constructs (`bun run scripts/dialect-lint.ts`); run it before every port
verification. `bun test` + `tsc --noEmit` do NOT see template-literal Cypher,
so the lint is the only guard against regression.

### Corrected command → file map

The analytical surface maps to files as follows (supersedes any earlier
6-file list):

| Command | Backing file |
|---------|--------------|
| `context` (retrieval) | `ts/src/intelligence/context-retrieval.ts` |
| `patterns` | `ts/src/intelligence/pattern-recognition.ts` |
| `entities` | `ts/src/intelligence/entity-extraction.ts` |
| `temporal` (getHistory/asOf/compare) | `ts/src/intelligence/temporal.ts` |
| `capture` (integration) | `ts/src/integration/context-capture.ts` |
| `briefing` | `ts/src/proactive/session-briefing.ts` |
| `predict` / `warn` | `ts/src/proactive/predictive.ts` |
| `outcome` / `learning` | `ts/src/proactive/outcome-learning.ts` |
| `visualize` / `similarity` / `learning` / `gaps` | `ts/src/analytics/advanced-queries.ts` |

Port verification runs against the dedicated **`memorygraph_test`** graph
(never the live `memorygraph` store); see `ts/tests/port-*.test.ts`.

## Known residuals (accepted after 2026-08-10 code review, follow-up queue)

- **Lint scope gap:** the dialect lint guards only the 9 ported analytical
  files. `ts/src/integration/workflow-tracking.ts` (`datetime()` ~L145,
  `NOT EXISTS {` ~L500) and `ts/src/integration/project-analysis.ts`
  (`datetime()` ~L305, ~L532) still carry rejected constructs and are wired to
  the `analyze-project` / `workflow` CLI commands — they fail against v4.16.3
  and silently exit 0 (the executeQuery wrapper). Extend the port + lint scope
  to these two files as a follow-up.
- **patterns renderer:** `ts/src/cli.ts` `cmdPatterns` reads `s['title']`/`s['id']`
  but `findSimilarProblems` returns `problem_title`/`problem_id`, so the CLI
  prints "Unknown (similarity: X)". Pre-existing (unchanged by the port); fix
  the renderer in a follow-up.
- **FalkorDB undirected-match semantics:** `MATCH (a)-[r]-(b)` yields one row
  per orientation. The port dedups on sorted endpoints (visualize) — audit any
  future undirected pattern against this.
- **Schema-init stderr noise** ("Attribute 'x' is already indexed" / "Invalid
  constraint command") on every CLI call is a known degradation; assert on
  stdout content, not stderr.

## Context

Applied 2026-08-05 as part of the `desktop-link` plan
`docs/plans/2026-08-05-002-feat-memorygraph-falkordb-docker-plan.md`. The scribe
(`@escriba`) runs the FalkorDB backend via this fork against a Dockerized
FalkorDB v4.16.3 (`~/source/memorygraph-docker/docker-compose.yml`). The
analytical layer (`visualize`/`briefing`/`similarity`/`patterns`) was ported to
the modern dialect on 2026-08-10 (`feat: semantic memory return` plan) — see
"Analytical-layer deviations" above; those commands are now content-correct
against FalkorDB v4.

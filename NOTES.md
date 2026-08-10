# Local Fork Notes

This clone carries an **intentional local divergence** from upstream
`https://github.com/memory-graph/memory-graph` so the CLI works against a
modern FalkorDB server (v4.x, Redis 8.6.3). These are working-tree edits; do
not push them upstream.

## Divergence (2 lines in `ts/src/backends/falkordb-shared.ts`)

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

After `git pull` / `git reset --hard` / `git clean`, re-apply the two edits above.
The divergence is deliberately kept to these two lines to make re-application
trivial and conflict resolution predictable.

## Context

Applied 2026-08-05 as part of the `desktop-link` plan
`docs/plans/2026-08-05-002-feat-memorygraph-falkordb-docker-plan.md`. The scribe
(`@escriba`) runs the FalkorDB backend via this fork against a Dockerized
FalkorDB v4.16.3 (`~/source/memorygraph-docker/docker-compose.yml`). The
analytical layer (`visualize`/`briefing`/`similarity`/`patterns`) is **not**
ported to the modern dialect — those commands remain broken on a server
backend and are out of scope (follow-up maintenance on this fork).

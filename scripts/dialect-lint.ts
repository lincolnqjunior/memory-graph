/**
 * Dialect lint for ported analytical-layer files.
 *
 * Scans the ported memory-graph files for FalkorDB v4.x REJECTED Cypher
 * constructs so `tsc`/`bun test` blind spots (template-literal Cypher that
 * the compiler never sees) are covered. Verified live against FalkorDB
 * v4.16.3 (2026-08-10 planning/port session):
 *
 *   - `datetime()`            → Unknown function
 *   - `duration.between(...)` → Unknown function
 *   - `NOT EXISTS { MATCH }`  → Invalid input '(' (subquery syntax)
 *   - `EXISTS { MATCH }`      → Invalid input '(' (subquery syntax)
 *   - `count { MATCH }`       → Invalid input '(' (subquery syntax)
 *   - `LIMIT $x` / `SKIP $x`  → "Limit operates only on non-negative integers"
 *   - `exists((n)-[:T]->())`  → "Unable to resolve filtered alias"
 *     as a standalone predicate. The WORKING form is
 *     `any(x IN [...] WHERE exists((n)-[:T]->(...)))`.
 *   - `collect({...})` nested  → "Invalid use of aggregating function 'collect'"
 *     inside another aggregating query (advanced-queries visualize).
 *   - pipe-relationships `<-[:A|B]-` cause cascading parse failures in
 *     stacked clauses (ORDER BY ... DESC errors trace to these sites).
 *
 * Exit code 0 when clean; 1 when a forbidden construct is found. Wired as
 * `bun run scripts/dialect-lint.ts` and invoked before each port verification.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = join(ROOT, "ts", "src");

/** Ported analytical-layer files — the lint scope (NOT the whole tree). */
const PORTED_FILES = [
  "intelligence/context-retrieval.ts",
  "intelligence/pattern-recognition.ts",
  "intelligence/temporal.ts",
  "intelligence/entity-extraction.ts",
  "proactive/session-briefing.ts",
  "proactive/predictive.ts",
  "proactive/outcome-learning.ts",
  "analytics/advanced-queries.ts",
  "integration/context-capture.ts",
  "integration/workflow-tracking.ts",
  "integration/project-analysis.ts",
];

/**
 * Forbidden construct regexes. Each entry: [regex, label].
 * `datetime(` covers both bare and argument forms.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bdatetime\(/g, "datetime()"],
  [/\bduration\.between\(/g, "duration.between()"],
  [/\b(?:NOT\s+)?EXISTS\s*\{/g, "EXISTS { } subquery"],
  [/\bcount\s*\{/g, "count { } subquery"],
  // parameterized LIMIT/SKIP — `LIMIT $param` is rejected by FalkorDB v4;
  // `LIMIT ${expr}` template interpolation renders to a literal integer and
  // is the sanctioned form, so allow it via a negative lookahead.
  [/\bLIMIT\s+\$(?!\{)/g, "parameterized LIMIT"],
  [/\bSKIP\s+\$(?!\{)/g, "parameterized SKIP"],
  // pipe-relationship type lists: [r:SOLVES|SOLVED_BY] or <-[:A|B]-.
  // Matches a rel-type pipe (`:TYPE1|TYPE2`), NOT a list-comprehension
  // pipe (`[x IN list | x.prop]` which has no colon before the pipe).
  [/\[[^\[\]\n]*:[A-Za-z0-9_]+(?:\|[A-Za-z0-9_]+)+[^\[\]\n]*\]/g, "pipe-relationship"],
  [/\bid\([\w.]+\)/g, "id() function"],
  [/\bstartNode\([^)]*\)\.id\b/g, "startNode(rel).id"],
];

interface Finding {
  file: string;
  line: number;
  label: string;
  match: string;
}

function lintFile(relPath: string, findings: Finding[]): void {
  const abs = join(SRC, relPath);
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    // file missing — non-fatal; lets the port proceed file-by-file
    return;
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [re, label] of FORBIDDEN) {
      // regex is stateful with /g — reset lastIndex per line
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) {
        findings.push({
          file: relPath,
          line: i + 1,
          label,
          match: m[0],
        });
        break; // one finding per line is enough to fix
      }
    }
    // standalone exists((n)-[..]->(..)) predicate — the working form is
    // `any(x IN [...] WHERE exists((n)-[:T]->(..)))`, so allow when `any(`
    // appears on the same line.
    if (/\bexists\(\(/.test(line) && !/any\(/.test(line)) {
      findings.push({
        file: relPath,
        line: i + 1,
        label: "standalone exists((..))",
        match: "exists((",
      });
    }
  }
}

function run(): void {
  const findings: Finding[] = [];
  for (const rel of PORTED_FILES) lintFile(rel, findings);

  if (findings.length === 0) {
    console.log(`dialect-lint: clean (${PORTED_FILES.length} files checked)`);
    process.exit(0);
  }

  console.error(`dialect-lint: ${findings.length} forbidden construct(s) found`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.label}]  ${JSON.stringify(f.match)}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  run();
}

// Export for tests.
export { PORTED_FILES, FORBIDDEN };

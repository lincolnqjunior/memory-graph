/**
 * Observability grading for memorygraph nodes (#28).
 *
 * Derives `observability ∈ {exact, estimated, unavailable}` from
 * objective signals (no LLM):
 *   - exact:      solution/error node with DEC-NNN/ERR-NNN in title AND
 *                a matching docs/decisions/*-{dec|err}-NNN-*.md file
 *   - estimated:  solution/error node without matching ADR
 *   - unavailable: any other memory type (conversation, project, ...)
 *
 * Performance: `buildObservabilityClassifier` loads the decisions
 * listing ONCE per instance (readdirSpy guard verified in tests).
 * Naive per-memory readdirSync is forbidden — Windows sync FS makes it
 * prohibitive for the 70-node desktop-link grafo.
 *
 * Multi-repo: the fork is shared across operacional / billing-ke /
 * desktop-link tags. `repoRoot` is explicit (default: process.cwd())
 * and crons pass it directly; no docs/decisions under cwd → grade
 * degrades to estimated/unavailable naturally.
 *
 * ERR-NNN nodes are almost always `estimated` (ADRs are DEC, not ERR) —
 * that is semantically correct, not a bug.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Memory } from "../models.js";

export const OBSERVABILITY_VALUES = ["exact", "estimated", "unavailable"] as const;
export type Observability = (typeof OBSERVABILITY_VALUES)[number];

export function isObservability(value: string): value is Observability {
  return (OBSERVABILITY_VALUES as readonly string[]).includes(value);
}

const ID_RE = /\b(DEC|ERR)-\d+\b/;

function decisionsListing(repoRoot: string): string[] | null {
  const decisionsDir = join(repoRoot, "docs", "decisions");
  if (!existsSync(decisionsDir)) return null;
  try {
    return readdirSync(decisionsDir).map((name) => name.toLowerCase());
  } catch {
    return null;
  }
}

export function classifyObservability(
  memory: Pick<Memory, "type" | "title">,
  repoRoot: string,
): Observability {
  if (memory.type !== "solution" && memory.type !== "error") {
    return "unavailable";
  }
  const idMatch = memory.title.match(ID_RE);
  if (idMatch === null) return "unavailable";
  const needle = idMatch[0].toLowerCase();
  const listing = decisionsListing(repoRoot);
  if (listing === null) return "estimated";
  const hit = listing.some((name) => name.includes(`-${needle}-`));
  return hit ? "exact" : "estimated";
}

export type Classifier = (memory: Pick<Memory, "type" | "title">) => Observability;

export type ClassifierDeps = {
  repoRoot: string;
  readdirFn?: (path: string) => string[];
  existsFn?: (path: string) => boolean;
};

export function buildObservabilityClassifier(deps: ClassifierDeps): Classifier {
  const exists = deps.existsFn ?? ((p: string) => existsSync(p));
  const readdir = deps.readdirFn ?? ((p: string) => readdirSync(p));
  const decisionsDir = join(deps.repoRoot, "docs", "decisions");
  let listing: string[] | null | undefined;
  function getListing(): string[] | null {
    if (listing !== undefined) return listing;
    if (!exists(decisionsDir)) {
      listing = null;
      return listing;
    }
    try {
      listing = readdir(decisionsDir).map((name) => name.toLowerCase());
      return listing;
    } catch {
      listing = null;
      return listing;
    }
  }
  return (memory) => {
    if (memory.type !== "solution" && memory.type !== "error") return "unavailable";
    const idMatch = memory.title.match(ID_RE);
    if (idMatch === null) return "unavailable";
    const needle = idMatch[0].toLowerCase();
    const list = getListing();
    if (list === null) return "estimated";
    return list.some((name) => name.includes(`-${needle}-`)) ? "exact" : "estimated";
  };
}

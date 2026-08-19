/**
 * Auto-link tool — CLI handler for `memorygraph autolink`.
 *
 * Pulls memories by tag, runs the pure-logic `proposeEdges` (in
 * `./intelligence/autolink.ts`), and either prints a dry-run report or
 * applies the accept-bucket edges via `linkIfMissing`. REPLACES is never
 * auto-created (gate lives in #31). Edges already present on the source
 * memory are skipped by `linkIfMissing` (1-hop idempotency).
 */

import { z } from "zod";

import { handleToolErrors } from "./error-handling.js";
import type { IMemoryDatabase } from "../database.js";
import {
  proposeEdges,
  linkIfMissing,
  DEFAULT_ALLOW_TYPES,
  type ProposedEdge,
  type ProposeResult,
} from "../intelligence/autolink.js";
import {
  SearchQuerySchema,
  type RelationshipType,
  type Memory,
} from "../models.js";

const REPLACES_GATE_MESSAGE =
  "REPLACES is never auto-created (per #26 review gate). Use #31 consolidation with human gate.";

const TYPES_VALUES = Array.from(DEFAULT_ALLOW_TYPES);

export const AutoLinkArgsSchema = z
  .object({
    tag: z.string().optional(),
    memory_id: z.string().optional(),
    min_confidence: z.number().min(0).max(1).default(0.7),
    apply: z.boolean().default(false),
    rules: z.array(z.string()).optional(),
    types: z
      .array(z.enum(TYPES_VALUES as [string, ...string[]]))
      .optional()
      .refine((arr) => !arr?.includes("REPLACES" as RelationshipType), {
        message: REPLACES_GATE_MESSAGE,
      }),
  })
  .refine((v) => v.tag !== undefined || v.memory_id !== undefined, {
    message: "Provide --tag <project-slug> or --memory-id <uuid>.",
  });

export type AutoLinkArgs = z.infer<typeof AutoLinkArgsSchema>;

export type AutoLinkOutcome = {
  scanned: number;
  accept: ProposedEdge[];
  review: ProposedEdge[];
  rejected: number;
  applied: number;
  skipped_duplicate: number;
  failed: number;
  errors: string[];
  dry_run: boolean;
};

export class AutoLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoLinkError";
  }
}

function parseRulesCsv(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

export const handleAutoLink = handleToolErrors(
  "auto-link",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    const parsed = AutoLinkArgsSchema.parse(args);
    const { tag, memory_id: memoryId, min_confidence: minConfidence, apply } = parsed;
    const allowTypes = new Set<RelationshipType>(
      (parsed.types ?? Array.from(DEFAULT_ALLOW_TYPES)) as RelationshipType[],
    );
    const rules = parsed.rules ?? parseRulesCsv(args["rules"] as string | undefined);

    let memories: Memory[];
    if (tag) {
      const query = SearchQuerySchema.parse({
        tags: [tag],
        limit: 1000,
        offset: 0,
      });
      memories = await db.searchMemories(query);
    } else if (memoryId) {
      const m = await db.getMemory(memoryId, false);
      memories = m ? [m] : [];
    } else {
      memories = [];
    }

    const result: ProposeResult = proposeEdges(memories, {
      minConfidence,
      allowTypes,
      ...(rules ? { excludeRules: new Set(rules) } : {}),
    });

    const outcome: AutoLinkOutcome = {
      scanned: memories.length,
      accept: result.accept,
      review: result.review,
      rejected: result.rejected.length,
      applied: 0,
      skipped_duplicate: 0,
      failed: 0,
      errors: [],
      dry_run: !apply,
    };

    if (apply) {
      for (const edge of result.accept) {
        const r = await linkIfMissing(db, edge);
        if (r.created) {
          outcome.applied += 1;
        } else if (r.skipped === "duplicate") {
          outcome.skipped_duplicate += 1;
        } else {
          outcome.failed += 1;
          if (r.error) outcome.errors.push(r.error);
        }
      }
    }

    return formatReport(outcome);
  },
);

function formatReport(outcome: AutoLinkOutcome): string {
  const lines: string[] = [];
  lines.push(`Auto-link ${outcome.dry_run ? "DRY-RUN" : "APPLY"} report`);
  lines.push(`- Memories scanned: ${outcome.scanned}`);
  lines.push(`- Accept edges: ${outcome.accept.length}`);
  lines.push(`- Review edges (not persisted): ${outcome.review.length}`);
  lines.push(`- Rejected edges (below 0.5 confidence): ${outcome.rejected}`);
  if (!outcome.dry_run) {
    lines.push(`- Applied: ${outcome.applied}`);
    lines.push(`- Skipped (duplicate): ${outcome.skipped_duplicate}`);
    lines.push(`- Failed: ${outcome.failed}`);
    if (outcome.errors.length > 0) {
      lines.push(`- Errors:`);
      for (const e of outcome.errors) lines.push(`    - ${e}`);
    }
  }
  if (outcome.accept.length > 0) {
    lines.push(``);
    lines.push(`Accept edges (top 20 by confidence):`);
    lines.push(`| from | to | type | confidence | rule | matchedPattern |`);
    lines.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const e of outcome.accept.slice(0, 20)) {
      const pattern = e.evidence.matchedPattern.replace(/\|/g, "\\|");
      lines.push(
        `| ${e.from.slice(0, 8)} | ${e.to.slice(0, 8)} | ${e.type} | ${e.confidence.toFixed(2)} | ${e.evidence.rule} | ${pattern} |`,
      );
    }
  }
  if (outcome.review.length > 0) {
    lines.push(``);
    lines.push(`Review edges (top 20 by confidence):`);
    lines.push(`| from | to | type | confidence | rule | matchedPattern |`);
    lines.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const e of outcome.review.slice(0, 20)) {
      const pattern = e.evidence.matchedPattern.replace(/\|/g, "\\|");
      lines.push(
        `| ${e.from.slice(0, 8)} | ${e.to.slice(0, 8)} | ${e.type} | ${e.confidence.toFixed(2)} | ${e.evidence.rule} | ${pattern} |`,
      );
    }
  }
  return lines.join("\n");
}

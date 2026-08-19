import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { handleToolErrors } from "./error-handling.js";
import type { IMemoryDatabase } from "../database.js";
import { SearchQuerySchema } from "../models.js";
import {
  generateConsolidationReport,
  formatReportMarkdown,
  type ConsolidateOptions,
} from "../intelligence/consolidate.js";

export type ConsolidateArgs = {
  tag?: string;
  memory_id?: string;
  superseded_age_days?: number;
  superseded_importance_max?: number;
  archive_age_days?: number;
  archive_importance_max?: number;
  out_path?: string;
};

export class ConsolidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsolidateError";
  }
}

export const handleConsolidate = handleToolErrors(
  "consolidate",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    const a = args as unknown as ConsolidateArgs;
    if (!a.tag && !a.memory_id) {
      throw new ConsolidateError(
        "Provide --tag <project-slug> or --memory-id <uuid>.",
      );
    }
    const now = new Date();
    const opts: ConsolidateOptions = {
      supersededAgeDays: a.superseded_age_days ?? 30,
      supersededImportanceMax: a.superseded_importance_max ?? 0.4,
      archiveAgeDays: a.archive_age_days ?? 180,
      archiveImportanceMax: a.archive_importance_max ?? 0,
    };
    const dialectLimits: string[] = [];
    let memories: Awaited<ReturnType<IMemoryDatabase["searchMemories"]>>;
    if (a.tag) {
      try {
        memories = await db.searchMemories(
          SearchQuerySchema.parse({
            tags: [a.tag],
            limit: 1000,
            offset: 0,
          }),
        );
      } catch (err) {
        dialectLimits.push(`falkordb-down: ${String(err)}`);
        memories = [];
      }
    } else {
      const m = await db.getMemory(a.memory_id as string, false);
      memories = m ? [m] : [];
    }
    const report = generateConsolidationReport(memories, now, opts);
    report.dialectLimits = dialectLimits;
    const markdown = formatReportMarkdown(report);
    let savedTo: string | undefined;
    if (a.out_path !== undefined && a.out_path.length > 0) {
      mkdirSync(dirname(a.out_path), { recursive: true });
      writeFileSync(a.out_path, markdown, "utf8");
      savedTo = a.out_path;
    }
    return [
      markdown,
      "",
      "## Persisted artifact",
      `mutations: ${report.mutations}`,
      `consolidate --dry-run wrote: ${savedTo ?? "(stdout only — pass --out <path> to persist)"}`,
    ].join("\n") + "\n";
  },
);

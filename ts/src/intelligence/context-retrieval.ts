/**
 * Context-Aware Retrieval - Intelligent context retrieval beyond keyword search.
 *
 * Port of the Python `memorygraph.intelligence.context_retrieval` module.
 * Provides smart context assembly, relevance ranking, and token-limited
 * context formatting.
 */

import type { GraphBackend } from "../backends/index.js";
import { extractEntities } from "./entity-extraction.js";

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface SourceMemory {
  id: string;
  title: string | null;
  relevance: number;
}

export interface QueryContext {
  context: string;
  source_memories: SourceMemory[];
  total_memories?: number;
  estimated_tokens?: number;
  query_entities?: string[];
  query_keywords?: string[];
  error?: string;
}

export interface ProjectSummary {
  total_memories?: number;
  recent_activity?: Record<string, unknown>[];
  decisions?: Record<string, unknown>[];
  open_problems?: Record<string, unknown>[];
  solutions?: Record<string, unknown>[];
  error?: string;
}

export interface SessionContext {
  recent_memories: Record<string, unknown>[];
  total_count: number;
  time_range_hours: number;
  active_entities: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Stop words (shared with pattern-recognition for consistency)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at",
  "to", "for", "of", "with", "by", "from", "is", "are",
  "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "should", "could", "may",
  "might", "can", "this", "that", "these", "those", "what", "which",
  "who", "when", "where", "why", "how",
]);

// ---------------------------------------------------------------------------
// Context retriever
// ---------------------------------------------------------------------------

export class ContextRetriever {
  backend: GraphBackend;

  constructor(backend: GraphBackend) {
    this.backend = backend;
  }

  /**
   * Get intelligent context for a query with smart ranking and token limiting.
   */
  async getContext(
    query: string,
    maxTokens = 4000,
    project: string | null = null
  ): Promise<QueryContext> {
    // Extract entities from query for matching
    const entities = extractEntities(query);
    const entityTexts = entities.filter((e) => e.confidence > 0.6).map((e) => e.text);

    // Extract keywords for fallback matching
    const keywords = this.extractKeywords(query);

    const searchQuery = `
      // Find memories matching entities or keywords
      MATCH (m:Memory)
      WHERE (
        any(entity IN $entities WHERE exists((m)-[:MENTIONS]->(:Entity {text: entity})))
        OR
        any(keyword IN $keywords WHERE
          toLower(m.content) CONTAINS keyword OR
          toLower(m.title) CONTAINS keyword
        )
      )
      AND ($project IS NULL OR $project IN m.tags)
      RETURN m.id as id,
             m.title as title,
             m.content as content,
             m.type as memory_type,
             m.tags as tags,
             m.created_at as created_at
    `;

    const entityMatchQuery = `
      MATCH (m:Memory)-[:MENTIONS]->(e:Entity)
      WHERE m.id IN $ids AND e.text IN $entities
      RETURN m.id as memory_id, count(DISTINCT e) as entity_matches
    `;

    const relatedQuery = `
      MATCH (m:Memory)-[r]->(related:Memory)
      WHERE m.id IN $ids
        AND type(r) IN ['SOLVES', 'BUILDS_ON', 'REQUIRES', 'RELATED_TO']
      RETURN m.id as memory_id,
             related.id as id,
             related.title as title,
             type(r) as rel_type,
             coalesce(r.strength, 0.5) as rel_strength
    `;

    const params: Record<string, unknown> = {
      entities: entityTexts,
      keywords,
      project,
    };

    try {
      const results = await this.backend.executeQuery(searchQuery, params, false);

      // FalkorDB v4 has no duration.between; relevance ranking is computed
      // in TS from the fetched ISO timestamps and match counts. Rank ALL
      // matches first (preserves the original rank-then-limit semantics),
      // then slice to the top 20.
      const nowMs = Date.now();

      // Entity matches are a graph-edge count (MENTIONS), not a substring
      // check — fetch the real counts over the candidate ids.
      const allIds = results.map((r) => String(r["id"] ?? ""));
      const entityMatchCounts = new Map<string, number>();
      if (allIds.length > 0) {
        const emResults = await this.backend.executeQuery(
          entityMatchQuery,
          { ids: allIds, entities: entityTexts },
          false
        );
        for (const rec of emResults) {
          entityMatchCounts.set(String(rec["memory_id"] ?? ""), Number(rec["entity_matches"] ?? 0));
        }
      }

      const ranked = results
        .map((record) => {
          const content = String(record["content"] ?? "").toLowerCase();
          const title = String(record["title"] ?? "").toLowerCase();
          const entityMatches = entityMatchCounts.get(String(record["id"] ?? "")) ?? 0;
          const keywordMatches = keywords.filter(
            (k) => content.includes(k) || title.includes(k)
          ).length;
          const created = (record["created_at"] as string | null | undefined) ?? null;
          const ageDays = created ? Math.max(0, (nowMs - Date.parse(created)) / 86400000) : 0;
          const raw = entityMatches * 3 + keywordMatches * 2;
          return {
            ...record,
            entity_matches: entityMatches,
            keyword_matches: keywordMatches,
            relevance_score: raw / (1.0 + ageDays / 30.0),
          } as Record<string, unknown>;
        })
        .sort((a, b) => {
          const scoreDiff = Number(b["relevance_score"] ?? 0) - Number(a["relevance_score"] ?? 0);
          if (scoreDiff !== 0) return scoreDiff;
          return String(b["created_at"] ?? "").localeCompare(String(a["created_at"] ?? ""));
        })
        .slice(0, 20);

      const ids = ranked.map((r) => String(r["id"] ?? ""));
      const relatedByMemory = new Map<string, Record<string, unknown>[]>();
      if (ids.length > 0) {
        const relatedResults = await this.backend.executeQuery(relatedQuery, { ids }, false);
        for (const rec of relatedResults) {
          const memoryId = String(rec["memory_id"] ?? "");
          const key = `${String(rec["id"] ?? "")}|${String(rec["rel_type"] ?? "")}|${String(rec["rel_strength"] ?? "")}`;
          const list = relatedByMemory.get(memoryId);
          if (!list) {
            relatedByMemory.set(memoryId, [
              {
                id: rec["id"],
                title: rec["title"] ?? null,
                rel_type: rec["rel_type"],
                rel_strength: Number(rec["rel_strength"] ?? 0.5),
              },
            ]);
          } else if (!list.some((x) => `${x["id"]}|${x["rel_type"]}|${x["rel_strength"]}` === key)) {
            list.push({
              id: rec["id"],
              title: rec["title"] ?? null,
              rel_type: rec["rel_type"],
              rel_strength: Number(rec["rel_strength"] ?? 0.5),
            });
          }
        }
      }

      const contextParts: string[] = [];
      const sourceMemories: SourceMemory[] = [];
      let estimatedTokens = 0;

      for (const record of ranked) {
        record["related_memories"] = relatedByMemory.get(String(record["id"] ?? "")) ?? [];
        const memorySummary = this.formatMemory(record);
        const memoryTokens = this.estimateTokens(memorySummary);

        if (estimatedTokens + memoryTokens > maxTokens) {
          break;
        }

        contextParts.push(memorySummary);
        sourceMemories.push({
          id: String(record["id"] ?? ""),
          title: (record["title"] as string | null | undefined) ?? null,
          relevance: Number(record["relevance_score"] ?? 0),
        });
        estimatedTokens += memoryTokens;
      }

      const context = contextParts.join("\n\n");

      return {
        context,
        source_memories: sourceMemories,
        total_memories: sourceMemories.length,
        estimated_tokens: estimatedTokens,
        query_entities: entityTexts,
        query_keywords: keywords,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error retrieving context for query '${query}': ${message}`);
      return {
        context: "",
        source_memories: [],
        error: message,
      };
    }
  }

  /**
   * Get comprehensive overview of a project.
   */
  async getProjectContext(project: string): Promise<ProjectSummary> {
    const query = `
      MATCH (m:Memory)
      WHERE $project IN m.tags
      RETURN m.id as id, m.title as title, m.type as type, m.created_at as created_at
      ORDER BY m.created_at DESC
    `;

    const params = { project };

    try {
      const results = await this.backend.executeQuery(query, params, false);

      // FalkorDB v4.16.3 anonymous pattern comprehensions inside list
      // comprehensions mis-evaluate (size([(x)<-[:SOLVES]-()]) returns 1
      // even with no matching edge); do the categorization in TS.
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      const all = results as Record<string, unknown>[];
      const recent = all.filter((m) => String(m["created_at"] ?? "") >= cutoff).slice(0, 10);
      const decisions = all.filter((m) => m["type"] === "decision").slice(0, 5);
      const solutions = all.filter((m) => m["type"] === "solution").slice(0, 5);
      const problemIds = all
        .filter((m) => m["type"] === "problem")
        .map((m) => String(m["id"] ?? ""));

      // Determine which problems already have a SOLVES link (top-level
      // pattern predicate is supported; anonymous pattern comps are not).
      const solvedIds = new Set<string>();
      if (problemIds.length > 0) {
        const solvedQuery = `
          MATCH (s)-[:SOLVES]->(p:Memory)
          WHERE p.id IN $ids
          RETURN DISTINCT p.id as id
        `;
        const solvedRes = await this.backend.executeQuery(solvedQuery, { ids: problemIds }, false);
        for (const rec of solvedRes) solvedIds.add(String(rec["id"] ?? ""));
      }
      const openProblems = all
        .filter((m) => m["type"] === "problem" && !solvedIds.has(String(m["id"] ?? "")))
        .slice(0, 5);

      const projectSummary: ProjectSummary = {
        total_memories: all.length,
        recent_activity: recent.map((m) => ({
          id: m["id"],
          title: m["title"],
          type: m["type"],
          created_at: m["created_at"],
        })),
        decisions: decisions.map((m) => ({
          id: m["id"],
          title: m["title"],
          created_at: m["created_at"],
        })),
        open_problems: openProblems.map((m) => ({
          id: m["id"],
          title: m["title"],
          created_at: m["created_at"],
        })),
        solutions: solutions.map((m) => ({
          id: m["id"],
          title: m["title"],
          created_at: m["created_at"],
        })),
      };

      return projectSummary;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error getting project context for '${project}': ${message}`);
      return { error: message };
    }
  }

  /**
   * Get recent session context from the last N hours.
   */
  async getSessionContext(hoursBack = 24, limit = 10): Promise<SessionContext> {
    const cutoff = new Date(Date.now() - hoursBack * 3600000).toISOString();
    const intLimit = Math.max(0, Math.floor(Number(limit) || 10));

    const query = `
      MATCH (m:Memory)
      WHERE m.created_at >= $cutoff

      WITH m
      ORDER BY m.created_at DESC
      LIMIT ${intLimit}

      OPTIONAL MATCH (m)-[:MENTIONS]->(e:Entity)
      WITH m, collect(DISTINCT e.text) as entities

      RETURN m.id as id,
             m.title as title,
             m.content as content,
             m.type as memory_type,
             m.created_at as created_at,
             entities
      ORDER BY m.created_at DESC
    `;

    const params = { cutoff };

    try {
      const results = await this.backend.executeQuery(query, params, false);

      const memories: Record<string, unknown>[] = [];
      const allEntities = new Set<string>();

      for (const record of results) {
        const entities = (record["entities"] as string[] | undefined) ?? [];
        memories.push({
          id: record["id"],
          title: record["title"] ?? null,
          type: record["memory_type"] ?? null,
          created_at: record["created_at"] ?? null,
          entities,
        });
        for (const e of entities) allEntities.add(e);
      }

      return {
        recent_memories: memories,
        total_count: memories.length,
        time_range_hours: hoursBack,
        active_entities: Array.from(allEntities),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error getting session context: ${message}`);
      return {
        recent_memories: [],
        total_count: 0,
        time_range_hours: hoursBack,
        active_entities: [],
        error: message,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private formatMemory(record: Record<string, unknown>): string {
    const title = (record["title"] as string | null | undefined) ?? "Untitled";
    const memoryType = (record["memory_type"] as string | null | undefined) ?? "unknown";
    let content = (record["content"] as string | null | undefined) ?? "";
    const relevance = Number(record["relevance_score"] ?? 0);

    if (content.length > 500) {
      content = content.slice(0, 497) + "...";
    }

    let formatted = `## ${title} (${memoryType})\n`;
    if (relevance > 0) {
      formatted += `Relevance: ${relevance.toFixed(2)}\n`;
    }
    formatted += `${content}`;

    const related = (record["related_memories"] as Record<string, unknown>[] | undefined) ?? [];
    if (related.length > 0) {
      const relatedTitles = related
        .slice(0, 3)
        .map((r) => (r["title"] as string | null | undefined) ?? "Untitled");
      formatted += `\n\nRelated: ${relatedTitles.join(", ")}`;
    }

    return formatted;
  }

  private estimateTokens(text: string): number {
    return Math.floor(text.length / 4);
  }

  private extractKeywords(text: string): string[] {
    const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
    const keywords = words.filter((w) => !STOP_WORDS.has(w));
    return Array.from(new Set(keywords));
  }
}

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

export async function getContext(
  backend: GraphBackend,
  query: string,
  maxTokens = 4000,
  project: string | null = null
): Promise<QueryContext> {
  const retriever = new ContextRetriever(backend);
  return retriever.getContext(query, maxTokens, project);
}

export async function getProjectContext(
  backend: GraphBackend,
  project: string
): Promise<ProjectSummary> {
  const retriever = new ContextRetriever(backend);
  return retriever.getProjectContext(project);
}

export async function getSessionContext(
  backend: GraphBackend,
  hoursBack = 24,
  limit = 10
): Promise<SessionContext> {
  const retriever = new ContextRetriever(backend);
  return retriever.getSessionContext(hoursBack, limit);
}

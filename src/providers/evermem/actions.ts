import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "evermem";

const roleField = s.stringEnum("Role of the message sender.", ["user", "assistant", "tool"]);
const methodField = s.stringEnum("Retrieval method.", ["keyword", "vector", "hybrid", "agentic"]);
const memoryTypeField = s.stringEnum("Type of memory to list; must match the owner (user or agent).", [
  "episode",
  "profile",
  "agent_case",
  "agent_skill",
]);
const sortByField = s.stringEnum("Field to sort by.", ["timestamp", "updated_at"]);
const sortOrderField = s.stringEnum("Sort direction.", ["asc", "desc"]);
const filtersField = s.record(
  "Optional EverOS filter DSL (recursive AND/OR over session_id, timestamp, sender_id, …).",
  true,
);

const memoryAddResultSchema = s.looseObject(
  {
    message_count: s.integer("Number of messages buffered by this call."),
    status: s.string("Buffer status after the add: accumulated or extracted."),
    flush_status: s.string("Flush status when auto-flush ran: extracted, no_extraction, or pending."),
  },
  { description: "The result of adding a memory, optionally auto-flushed." },
);

const memoryFlushResultSchema = s.looseObject(
  {
    status: s.string("Flush status: extracted or no_extraction."),
  },
  { description: "The result of flushing a session buffer." },
);

const episodeSchema = s.looseObject(
  {
    id: s.string("Episode identifier."),
    user_id: s.string("User the episode belongs to."),
    session_id: s.string("Session the episode was extracted from."),
    timestamp: s.string("Episode timestamp (ISO-8601 with offset)."),
    subject: s.string("Subject of the episode."),
    summary: s.string("Short summary of the episode."),
    episode: s.string("Full episode text."),
    score: s.number("Relevance score (search results only)."),
  },
  { description: "An EverOS episodic memory record." },
);

const profileSchema = s.looseObject(
  {
    id: s.string("Profile identifier."),
    user_id: s.string("User the profile belongs to."),
    profile_data: s.looseObject({}, { description: "Structured profile attributes." }),
    score: s.nullableNumber("Relevance score, or null on a direct fetch."),
  },
  { description: "An EverOS user profile record." },
);

const agentRecordSchema = s.looseObject({}, { description: "An EverOS agent case or skill record." });

const memorySearchResultSchema = s.looseObject(
  {
    episodes: s.array("Matching episodes (populated for a user owner).", episodeSchema),
    profiles: s.array("Matching profiles (when include_profile is set for a user owner).", profileSchema),
    agent_cases: s.array("Matching agent cases (populated for an agent owner).", agentRecordSchema),
    agent_skills: s.array("Matching agent skills (populated for an agent owner).", agentRecordSchema),
    unprocessed_messages: s.array("Buffered messages not yet extracted.", agentRecordSchema),
  },
  { description: "EverOS memory search results." },
);

const triggerResultSchema = s.looseObject(
  {
    status: s.string("Outcome of the trigger: ok or timeout."),
    name: s.string("The maintenance strategy that was triggered."),
  },
  { description: "The result of triggering a maintenance strategy." },
);

const memoryListResultSchema = s.looseObject(
  {
    episodes: s.array("Episodes on this page.", episodeSchema),
    profiles: s.array("Profiles on this page.", profileSchema),
    agent_cases: s.array("Agent cases on this page.", agentRecordSchema),
    agent_skills: s.array("Agent skills on this page.", agentRecordSchema),
    total_count: s.integer("Total matching records before pagination."),
    count: s.integer("Number of records on this page."),
  },
  { description: "A page of EverOS memories." },
);

function ownerFields(): Record<string, JsonSchema> {
  return {
    userId: s.nonEmptyString("User whose memories to query. Defaults to kedia unless agentId is given."),
    agentId: s.nonEmptyString("Agent whose memories to query. Mutually exclusive with userId; takes precedence."),
    appId: s.nonEmptyString("Application scope. Defaults to evermem."),
    projectId: s.nonEmptyString("Project scope. Defaults to global."),
  };
}

export const evermemActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "add_memory",
    description:
      "Add a memory to EverOS. Appends a message to the session buffer and, unless disabled, flushes to force extraction.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        content: s.nonEmptyString("The memory content to store."),
        sessionId: s.nonEmptyString("Session buffer to append to. Defaults to mcp-global."),
        userId: s.nonEmptyString("User the memory belongs to; used as the message sender_id. Defaults to kedia."),
        senderName: s.nonEmptyString("Display name of the sender."),
        appId: s.nonEmptyString("Application scope. Defaults to evermem."),
        projectId: s.nonEmptyString("Project scope. Defaults to global."),
        role: roleField,
        timestamp: s.positiveInteger("Message timestamp in Unix epoch milliseconds. Defaults to the current time."),
        autoFlush: s.boolean("Whether to flush after adding to force extraction. Defaults to true."),
      },
      { optional: ["sessionId", "userId", "senderName", "appId", "projectId", "role", "timestamp", "autoFlush"] },
    ),
    outputSchema: memoryAddResultSchema,
    followUpActions: ["evermem.search_memory"],
  }),
  defineProviderAction(service, {
    name: "flush_memory",
    description: "Flush an EverOS session buffer to force memory extraction now.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        sessionId: s.nonEmptyString("Session buffer to flush. Defaults to mcp-global."),
        appId: s.nonEmptyString("Application scope. Defaults to evermem."),
        projectId: s.nonEmptyString("Project scope. Defaults to global."),
      },
      { optional: ["sessionId", "appId", "projectId"] },
    ),
    outputSchema: memoryFlushResultSchema,
  }),
  defineProviderAction(service, {
    name: "search_memory",
    description: "Search EverOS memories for a user or agent with ranked hybrid retrieval.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        query: s.nonEmptyString("The search query."),
        ...ownerFields(),
        method: methodField,
        topK: s.integer("Number of results to return: -1 for the server default, or 1-100.", {
          minimum: -1,
          maximum: 100,
        }),
        includeProfile: s.boolean("Also return the user profile. Defaults to true for a user, false for an agent."),
        radius: s.number("Optional cosine-distance threshold (0-1).", { minimum: 0, maximum: 1 }),
        minScore: s.number("Optional post-fusion score floor (0-1).", { minimum: 0, maximum: 1 }),
        enableLlmRerank: s.boolean("Whether to LLM-rerank the results."),
        filters: filtersField,
      },
      {
        optional: [
          "userId",
          "agentId",
          "appId",
          "projectId",
          "method",
          "topK",
          "includeProfile",
          "radius",
          "minScore",
          "enableLlmRerank",
          "filters",
        ],
      },
    ),
    outputSchema: memorySearchResultSchema,
    followUpActions: ["evermem.list_memories"],
  }),
  defineProviderAction(service, {
    name: "list_memories",
    description: "List EverOS memories for a user or agent, paginated and sorted (no ranking).",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        ...ownerFields(),
        memoryType: memoryTypeField,
        page: s.positiveInteger("1-based page number. Defaults to 1."),
        pageSize: s.positiveInteger("Number of records per page (1-100). Defaults to 20.", { maximum: 100 }),
        sortBy: sortByField,
        sortOrder: sortOrderField,
        filters: filtersField,
      },
      {
        optional: [
          "userId",
          "agentId",
          "appId",
          "projectId",
          "memoryType",
          "page",
          "pageSize",
          "sortBy",
          "sortOrder",
          "filters",
        ],
      },
    ),
    outputSchema: memoryListResultSchema,
  }),
  defineProviderAction(service, {
    name: "trigger_maintenance",
    description:
      "Run an EverOS memory-maintenance strategy now (for example reflect_episodes). Returns immediately with the run outcome.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        name: s.nonEmptyString("Maintenance strategy to run, for example reflect_episodes."),
        timeout: s.number("Seconds to wait for the strategy to finish. Defaults to 120.", { minimum: 0 }),
        force: s.boolean("Run the strategy even if it is not otherwise due. Defaults to false."),
      },
      { optional: ["timeout", "force"] },
    ),
    outputSchema: triggerResultSchema,
  }),
];

export type EvermemActionName =
  | "add_memory"
  | "flush_memory"
  | "search_memory"
  | "list_memories"
  | "trigger_maintenance";

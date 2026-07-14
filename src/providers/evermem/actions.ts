import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "evermem";

const roleField = s.stringEnum("Role of the message sender.", ["user", "assistant", "tool"]);

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
    followUpActions: ["evermem.flush_memory"],
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
];

export type EvermemActionName = "add_memory" | "flush_memory";

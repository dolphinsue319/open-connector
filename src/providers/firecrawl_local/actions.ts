import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "firecrawl_local";

const looseObject = s.looseObject({}, { description: "A loose JSON object." });

export const firecrawlLocalActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "crawl_list_active",
    description: "List the currently active Firecrawl crawl jobs on the self-hosted instance.",
    inputSchema: s.looseObject({}, { description: "The input payload for this action." }),
    outputSchema: s.requiredObject("The output payload for this action.", {
      success: s.boolean("Whether the request succeeded."),
      crawls: s.array("The active crawl jobs returned by Firecrawl.", looseObject),
    }),
  }),
];

export type FirecrawlLocalActionName = "crawl_list_active";

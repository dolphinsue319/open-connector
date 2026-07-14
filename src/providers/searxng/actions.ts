import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "searxng";

const emptyInput = s.looseObject({}, { description: "The input payload for this action." });
const looseEntry = s.looseObject({}, { description: "A loose JSON object." });

const configResultSchema = s.looseObject(
  {
    instance_name: s.string("The configured instance name."),
    engines: s.array("The engines enabled on the instance.", looseEntry),
    categories: s.array("The search categories available on the instance.", s.string("A category name.")),
    plugins: s.array("The plugins enabled on the instance.", looseEntry),
  },
  { description: "The SearXNG instance configuration." },
);

export const searxngActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "config",
    description:
      "Get the self-hosted SearXNG instance configuration, including the enabled engines, categories, and plugins.",
    inputSchema: emptyInput,
    outputSchema: configResultSchema,
  }),
];

export type SearxngActionName = "config";

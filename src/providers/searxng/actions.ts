import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "searxng";

const emptyInput = s.looseObject({}, { description: "The input payload for this action." });
const looseEntry = s.looseObject({}, { description: "A loose JSON object." });
const unknownItem = s.unknown("A SearXNG response item, which may be a string or an object depending on the engine.");

const configResultSchema = s.looseObject(
  {
    instance_name: s.string("The configured instance name."),
    engines: s.array("The engines enabled on the instance.", looseEntry),
    categories: s.array("The search categories available on the instance.", s.string("A category name.")),
    plugins: s.array("The plugins enabled on the instance.", looseEntry),
  },
  { description: "The SearXNG instance configuration." },
);

const searchResultItemSchema = s.looseObject(
  {
    url: s.string("The result URL."),
    title: s.string("The result title."),
    content: s.string("The result snippet or summary."),
    engine: s.string("The engine that produced the result."),
    category: s.string("The result category."),
    score: s.number("The relevance score."),
    publishedDate: s.nullableString("The publication date, when the engine reports one."),
  },
  { description: "A single SearXNG search result." },
);

const searchResultSchema = s.looseObject(
  {
    query: s.string("The effective query that was executed."),
    number_of_results: s.nullableNumber("The reported result count; often null, so prefer the results array length."),
    results: s.array("The ranked search results.", searchResultItemSchema),
    answers: s.array("Instant answers extracted by SearXNG.", unknownItem),
    corrections: s.array("Suggested spelling or query corrections.", unknownItem),
    infoboxes: s.array("Infobox panels aggregated from the engines.", unknownItem),
    suggestions: s.array("Related query suggestions.", unknownItem),
    unresponsive_engines: s.array("Engines that failed to respond to this query.", unknownItem),
  },
  { description: "A SearXNG search response." },
);

const listParam = (description: string) =>
  s.oneOf([s.string("A comma-separated list."), s.stringArray("An array of values.")], { description });

export const searxngActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "config",
    description:
      "Get the self-hosted SearXNG instance configuration, including the enabled engines, categories, and plugins.",
    inputSchema: emptyInput,
    outputSchema: configResultSchema,
  }),
  defineProviderAction(service, {
    name: "search",
    description:
      "Search the web with the self-hosted SearXNG metasearch instance and return aggregated JSON results from the enabled engines.",
    inputSchema: s.looseRequiredObject(
      "The input payload for this action.",
      {
        q: s.nonEmptyString("The search query text."),
        categories: listParam("The SearXNG categories to search, e.g. general, news, images, videos, science."),
        engines: listParam("The specific engines to query, e.g. google, bing, duckduckgo."),
        language: s.string("The result language or locale, e.g. en, zh-TW, or all."),
        pageno: s.positiveInteger("The 1-based result page number."),
        time_range: s.stringEnum("Restrict results to a recent time range.", ["day", "week", "month", "year"]),
        safesearch: s.integer("The safe-search level: 0 (off), 1 (moderate), or 2 (strict).", {
          minimum: 0,
          maximum: 2,
        }),
      },
      { optional: ["categories", "engines", "language", "pageno", "time_range", "safesearch"] },
    ),
    outputSchema: searchResultSchema,
  }),
];

export type SearxngActionName = "config" | "search";

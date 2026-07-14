import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "firecrawl_local";

const looseObject = s.looseObject({}, { description: "A loose JSON object." });
const headersSchema = s.record(s.string("A custom HTTP header value."), {
  description: "Custom HTTP headers to send with the request.",
});
const stringArrayItem = s.string("A string value.", { minLength: 1 });
const formatObjectSchema = s.looseRequiredObject(
  "A structured Firecrawl format descriptor.",
  { type: s.nonEmptyString("The structured format type, such as json or screenshot.") },
  { optional: [] },
);
const formatSchema = s.oneOf(
  [
    s.stringEnum("A built-in Firecrawl output format.", [
      "markdown",
      "html",
      "rawHtml",
      "links",
      "screenshot",
      "screenshot@fullPage",
      "json",
      "changeTracking",
      "summary",
    ]),
    formatObjectSchema,
  ],
  { description: "A requested Firecrawl output format." },
);
const jsonOptionsSchema = s.looseRequiredObject(
  "Options for structured JSON output.",
  {
    prompt: s.string("An extraction prompt that explains the desired JSON structure."),
    schema: looseObject,
  },
  { optional: ["prompt", "schema"] },
);
const locationSchema = s.looseRequiredObject(
  "Location settings for the request.",
  {
    country: s.string("The ISO 3166-1 alpha-2 country code to request from."),
    languages: s.array("The preferred locales for the request.", stringArrayItem),
  },
  { optional: ["country", "languages"] },
);
const browserActionSchema = s.looseRequiredObject(
  "A browser action to perform before scraping.",
  {
    type: s.nonEmptyString("The browser action type, such as click, write, wait, or press."),
    selector: s.string("The CSS selector targeted by the action."),
    text: s.string("The text to type for write actions."),
    key: s.string("The key to press for press actions."),
    milliseconds: s.integer("The duration in milliseconds used by wait-style actions."),
  },
  { optional: ["selector", "text", "key", "milliseconds"] },
);
const scrapeOptionsSchema = s.looseRequiredObject(
  "Shared Firecrawl scrape options.",
  {
    actions: s.array("The browser actions to perform before extraction.", browserActionSchema),
    formats: s.array("The formats to return from Firecrawl.", formatSchema),
    headers: headersSchema,
    location: locationSchema,
    jsonOptions: jsonOptionsSchema,
    timeout: s.integer("The request timeout in milliseconds."),
    waitFor: s.integer("The delay in milliseconds before extraction starts."),
    maxAge: s.integer("The cache max age in milliseconds."),
    onlyMainContent: s.boolean("Whether to keep only the main content of the page."),
    mobile: s.boolean("Whether to emulate a mobile device."),
    includeTags: s.stringArray("The HTML tags that should be prioritized in the extracted content."),
    excludeTags: s.stringArray("The HTML tags that should be removed from the extracted content."),
    parsers: s.stringArray("The parser plugins to enable for the request."),
    parsePDF: s.boolean("Whether PDF parsing should be enabled."),
    proxy: s.stringEnum("The proxy mode to use for the request.", ["basic", "stealth", "auto"]),
    storeInCache: s.boolean("Whether Firecrawl should store the result in cache."),
    removeBase64Images: s.boolean("Whether base64-encoded images should be removed from the output."),
    blockAds: s.boolean("Whether ad resources should be blocked."),
    skipTlsVerification: s.boolean("Whether TLS certificate verification should be skipped."),
    changeTrackingOptions: looseObject,
  },
  {
    optional: [
      "actions",
      "formats",
      "headers",
      "location",
      "jsonOptions",
      "timeout",
      "waitFor",
      "maxAge",
      "onlyMainContent",
      "mobile",
      "includeTags",
      "excludeTags",
      "parsers",
      "parsePDF",
      "proxy",
      "storeInCache",
      "removeBase64Images",
      "blockAds",
      "skipTlsVerification",
      "changeTrackingOptions",
    ],
  },
);
const scrapeResultSchema = s.looseRequiredObject(
  "A Firecrawl scrape response.",
  {
    success: s.boolean("Whether the scrape request succeeded."),
    data: looseObject,
    warning: s.string("A warning returned by Firecrawl."),
    error: s.string("An error message returned by Firecrawl."),
  },
  { optional: ["data", "warning", "error"] },
);
const searchSchema = s.looseRequiredObject(
  "A Firecrawl search response.",
  {
    success: s.boolean("Whether the search request succeeded."),
    data: looseObject,
    warning: s.string("A warning returned by Firecrawl."),
  },
  { optional: ["data", "warning"] },
);
const mapSchema = s.looseRequiredObject(
  "A Firecrawl map response.",
  {
    success: s.boolean("Whether the map request succeeded."),
    links: s.stringArray("The URLs discovered by the map request."),
    warning: s.string("A warning returned by Firecrawl."),
  },
  { optional: ["warning"] },
);
const scrapeInput = s.looseRequiredObject(
  "The input payload for this action.",
  {
    url: s.nonEmptyString("The URL to scrape."),
    actions: s.array("The browser actions to run before scraping.", browserActionSchema),
    formats: s.array("The output formats to return.", formatSchema),
    headers: headersSchema,
    location: locationSchema,
    jsonOptions: jsonOptionsSchema,
    timeout: s.integer("The request timeout in milliseconds."),
    waitFor: s.integer("The delay before scraping starts."),
    maxAge: s.integer("The cache max age in milliseconds."),
    onlyMainContent: s.boolean("Whether to keep only the main content of the page."),
    includeTags: s.stringArray("The HTML tags that should be prioritized in the extracted content."),
    excludeTags: s.stringArray("The HTML tags that should be removed from the output."),
    mobile: s.boolean("Whether to emulate a mobile device."),
    proxy: s.stringEnum("The proxy mode to use for the request.", ["basic", "stealth", "auto"]),
    parsers: s.stringArray("The parser plugins to enable for the request."),
    blockAds: s.boolean("Whether ad resources should be blocked."),
    storeInCache: s.boolean("Whether Firecrawl should store the result in cache."),
    removeBase64Images: s.boolean("Whether base64-encoded images should be removed from the output."),
    skipTlsVerification: s.boolean("Whether TLS verification should be skipped."),
  },
  {
    optional: [
      "actions",
      "formats",
      "headers",
      "location",
      "jsonOptions",
      "timeout",
      "waitFor",
      "maxAge",
      "onlyMainContent",
      "includeTags",
      "excludeTags",
      "mobile",
      "proxy",
      "parsers",
      "blockAds",
      "storeInCache",
      "removeBase64Images",
      "skipTlsVerification",
    ],
  },
);

export const firecrawlLocalActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "scrape",
    description:
      "Scrape a single URL with self-hosted Firecrawl and return the extracted content in the requested formats.",
    inputSchema: scrapeInput,
    outputSchema: scrapeResultSchema,
  }),
  defineProviderAction(service, {
    name: "search",
    description:
      "Search the web with self-hosted Firecrawl and optionally scrape the top results in the requested formats.",
    inputSchema: s.looseRequiredObject(
      "The input payload for this action.",
      {
        query: s.nonEmptyString("The search query text."),
        limit: s.integer("The maximum number of search results to return."),
        country: s.string("The country code used to localize search results."),
        lang: s.string("The language code used to localize search results."),
        timeout: s.integer("The request timeout in milliseconds."),
        formats: s.array("The scrape formats to apply to each search result.", formatSchema),
        scrapeOptions: scrapeOptionsSchema,
      },
      { optional: ["limit", "country", "lang", "timeout", "formats", "scrapeOptions"] },
    ),
    outputSchema: searchSchema,
  }),
  defineProviderAction(service, {
    name: "map",
    description: "Discover URLs from a website with self-hosted Firecrawl's map endpoint.",
    inputSchema: s.looseRequiredObject(
      "The input payload for this action.",
      {
        url: s.nonEmptyString("The root URL to map."),
        limit: s.integer("The maximum number of links to return."),
        search: s.string("A search term used to filter discovered links."),
        timeout: s.integer("The request timeout in milliseconds."),
        ignoreQueryParameters: s.boolean("Whether query parameters should be ignored when deduplicating links."),
        includeSubdomains: s.boolean("Whether subdomains should be included."),
        sitemap: s.boolean("Whether sitemap discovery should be enabled."),
        location: locationSchema,
      },
      { optional: ["limit", "search", "timeout", "ignoreQueryParameters", "includeSubdomains", "sitemap", "location"] },
    ),
    outputSchema: mapSchema,
  }),
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

export type FirecrawlLocalActionName = "scrape" | "search" | "map" | "crawl_list_active";

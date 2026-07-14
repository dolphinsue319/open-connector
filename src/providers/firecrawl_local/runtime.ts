import type { CredentialValidationResult } from "../../core/types.ts";
import type { FirecrawlLocalActionName } from "./actions.ts";

import { compactObject, optionalRecord, optionalString } from "../../core/cast.ts";
import { providerUserAgent, ProviderRequestError } from "../provider-runtime.ts";

// Both the connector container and the self-hosted Firecrawl run in the same
// OrbStack host, so the default targets Firecrawl over the host gateway with no
// tunnel and no auth (Firecrawl runs with USE_DB_AUTHENTICATION=false).
export const defaultFirecrawlLocalBaseUrl = "http://host.docker.internal:3002";

// `/v2/crawl/active` is a cheap, parameter-free endpoint that returns Firecrawl's
// `{ success, crawls }` envelope — used to prove connectivity at connection time.
const firecrawlLocalValidationPath = "/v2/crawl/active";

type FirecrawlLocalRequestPhase = "validate" | "execute";

export interface FirecrawlLocalActionContext {
  baseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

type FirecrawlLocalActionHandler = (
  input: Record<string, unknown>,
  context: FirecrawlLocalActionContext,
) => Promise<unknown>;

/**
 * Action handlers keyed by the local action name (no service prefix). Entries
 * are added per implementation phase and must stay in sync with
 * `FirecrawlLocalActionName` in actions.ts.
 */
export const firecrawlLocalActionHandlers: Record<FirecrawlLocalActionName, FirecrawlLocalActionHandler> = {
  scrape: firecrawlLocalPostAction("/v2/scrape", buildDirectBody),
  search: firecrawlLocalPostAction("/v2/search", buildSearchBody),
  map: firecrawlLocalPostAction("/v2/map", buildDirectBody),
  crawl: firecrawlLocalPostAction("/v2/crawl", buildDirectBody),
  crawl_get: firecrawlLocalGetAction((input) => `/v2/crawl/${String(input.id)}`),
  crawl_cancel: firecrawlLocalDeleteAction((input) => `/v2/crawl/${String(input.id)}`),
  batch_scrape: firecrawlLocalPostAction("/v2/batch/scrape", buildDirectBody),
  batch_scrape_get: firecrawlLocalGetAction((input) => `/v2/batch/scrape/${String(input.id)}`),
  crawl_list_active: firecrawlLocalGetAction(() => firecrawlLocalValidationPath),
};

export async function validateFirecrawlLocalCredential(
  input: { values: Record<string, string> },
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const baseUrl = normalizeFirecrawlLocalBaseUrl(input.values.baseUrl);
  const payload = optionalRecord(
    await firecrawlLocalRequest({ baseUrl, fetcher, signal, path: firecrawlLocalValidationPath, phase: "validate" }),
  );

  // A real Firecrawl instance answers `/v2/crawl/active` with `{ success, crawls }`.
  // Guard against a stray 200 (an unrelated service or a health page) validating
  // green when the base URL does not actually point at Firecrawl.
  if (!payload || (payload.success === undefined && payload.crawls === undefined)) {
    throw new ProviderRequestError(502, "unexpected response from Firecrawl; check the base URL");
  }

  const host = new URL(baseUrl).host;
  return {
    profile: {
      accountId: `firecrawl_local:${host}`,
      displayName: `Firecrawl (${host})`,
    },
    grantedScopes: [],
    metadata: compactObject({
      baseUrl,
      validationEndpoint: firecrawlLocalValidationPath,
    }),
  };
}

/**
 * Parse the admin-configured self-hosted Firecrawl base URL. Unlike public-target
 * providers, this deliberately permits http and private/`.internal` hosts and does
 * NOT call `assertPublicHttpUrl`: the value is set by an admin at connection time
 * (PUT /api/connections) and points at a co-located Firecrawl instance. The
 * per-action `url`/`urls` inputs are forwarded to Firecrawl and never fetched by
 * open-connector, so relaxing this guard opens no new SSRF path. Mirrors
 * clickhouse's `normalizeClickhouseBaseUrl`.
 */
export function normalizeFirecrawlLocalBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  const raw = trimmed && trimmed.length > 0 ? trimmed : defaultFirecrawlLocalBaseUrl;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderRequestError(400, "baseUrl must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderRequestError(400, "baseUrl must use http or https");
  }

  // `origin` + `pathname` already exclude any query/hash, so a base URL with a
  // trailing query or fragment is dropped without needing to clear them.
  const pathname = url.pathname.replace(/\/+$/u, "");
  return pathname ? `${url.origin}${pathname}` : url.origin;
}

export function resolveFirecrawlLocalBaseUrl(input: {
  values: Record<string, string>;
  metadata: Record<string, unknown>;
}): string {
  return normalizeFirecrawlLocalBaseUrl(optionalString(input.metadata.baseUrl) ?? optionalString(input.values.baseUrl));
}

/**
 * Build an absolute Firecrawl API URL by concatenating the normalized base URL
 * with the endpoint path, preserving any instance sub-path.
 */
export function buildFirecrawlLocalApiUrl(baseUrl: string, path: string): string {
  return new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`).toString();
}

interface FirecrawlLocalRequestInput {
  baseUrl: string;
  fetcher: typeof fetch;
  path: string;
  phase: FirecrawlLocalRequestPhase;
  signal?: AbortSignal;
  method?: string;
  body?: Record<string, unknown>;
}

async function firecrawlLocalRequest(input: FirecrawlLocalRequestInput): Promise<unknown> {
  const url = buildFirecrawlLocalApiUrl(input.baseUrl, input.path);
  const headers = new Headers({ "user-agent": providerUserAgent });
  // No Authorization header: self-hosted Firecrawl runs with USE_DB_AUTHENTICATION=false.
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await input.fetcher(url, {
      method: input.method ?? "GET",
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: input.signal,
    });
  } catch (error) {
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `Firecrawl request failed: ${error.message}` : "Firecrawl request failed",
    );
  }

  const payload = await readFirecrawlLocalPayload(response);
  if (!response.ok) {
    throw createFirecrawlLocalError(response.status, payload, input.phase);
  }
  return payload;
}

function firecrawlLocalGetAction(buildPath: (input: Record<string, unknown>) => string): FirecrawlLocalActionHandler {
  return (input, context) =>
    firecrawlLocalRequest({
      baseUrl: context.baseUrl,
      fetcher: context.fetcher,
      signal: context.signal,
      path: buildPath(input),
      phase: "execute",
    });
}

function firecrawlLocalPostAction(
  path: string,
  buildBody: (input: Record<string, unknown>) => Record<string, unknown>,
): FirecrawlLocalActionHandler {
  return (input, context) =>
    firecrawlLocalRequest({
      baseUrl: context.baseUrl,
      fetcher: context.fetcher,
      signal: context.signal,
      method: "POST",
      path,
      body: buildBody(input),
      phase: "execute",
    });
}

function firecrawlLocalDeleteAction(
  buildPath: (input: Record<string, unknown>) => string,
): FirecrawlLocalActionHandler {
  return (input, context) =>
    firecrawlLocalRequest({
      baseUrl: context.baseUrl,
      fetcher: context.fetcher,
      signal: context.signal,
      method: "DELETE",
      path: buildPath(input),
      phase: "execute",
    });
}

function buildDirectBody(input: Record<string, unknown>): Record<string, unknown> {
  return compactObject(input);
}

// Firecrawl's search endpoint applies scrape formats via `scrapeOptions`. Accept a
// top-level `formats` alias and fold it into `scrapeOptions.formats` for convenience.
function buildSearchBody(input: Record<string, unknown>): Record<string, unknown> {
  const { formats, ...rest } = input;
  const formatsArray = Array.isArray(formats) ? formats : undefined;
  return compactObject({
    ...rest,
    scrapeOptions: mergeRecords(
      optionalRecord(rest.scrapeOptions),
      formatsArray ? { formats: formatsArray } : undefined,
    ),
  });
}

function mergeRecords(...records: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  const merged = Object.assign(
    {},
    ...records.filter((record): record is Record<string, unknown> => record !== undefined),
  );
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function readFirecrawlLocalPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return response.ok ? { data: text } : text;
  }
}

function createFirecrawlLocalError(
  status: number,
  payload: unknown,
  phase: FirecrawlLocalRequestPhase,
): ProviderRequestError {
  const message = readFirecrawlLocalErrorMessage(payload, status);
  if (status === 400 || status === 404) {
    return new ProviderRequestError(status, message, payload);
  }
  if (status === 401 || status === 403) {
    return new ProviderRequestError(phase === "validate" ? 400 : status, message, payload);
  }
  if (status === 429) {
    return new ProviderRequestError(429, message, payload);
  }
  return new ProviderRequestError(status || 502, message, payload);
}

function readFirecrawlLocalErrorMessage(payload: unknown, status: number): string {
  if (typeof payload === "string" && payload) {
    return payload;
  }
  const body = optionalRecord(payload);
  if (!body) {
    return `Firecrawl request failed with ${status}`;
  }
  const directError =
    optionalString(body.error) ?? optionalString(optionalRecord(body.error)?.message) ?? optionalString(body.message);
  const nestedData = optionalRecord(body.data);
  return directError ?? optionalString(nestedData?.error) ?? `Firecrawl request failed with ${status}`;
}

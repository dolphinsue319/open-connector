import type { CredentialValidationResult } from "../../core/types.ts";
import type { SearxngActionName } from "./actions.ts";

import { compactObject, optionalRecord, optionalString } from "../../core/cast.ts";
import { providerUserAgent, ProviderRequestError, setSearchParams } from "../provider-runtime.ts";

// Both the connector container and the self-hosted SearXNG run in the same
// OrbStack host, so the default targets SearXNG over the host gateway with no
// tunnel and no auth: SearXNG runs with its limiter disabled and its JSON API
// enabled, and the local path bypasses the public Cloudflare Access gate.
export const defaultSearxngBaseUrl = "http://host.docker.internal:8080";

// `/config` is a cheap, parameter-free endpoint that returns SearXNG's instance
// configuration (enabled engines, categories, plugins) as JSON — used to prove
// connectivity at connection time. It is served independently of the
// `search.formats: [json]` setting, so it works even where JSON search is off.
const searxngValidationPath = "/config";

type SearxngRequestPhase = "validate" | "execute";

export interface SearxngActionContext {
  baseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

type SearxngActionHandler = (input: Record<string, unknown>, context: SearxngActionContext) => Promise<unknown>;

/**
 * Action handlers keyed by the local action name (no service prefix). Entries
 * are added per implementation phase and must stay in sync with
 * `SearxngActionName` in actions.ts.
 */
export const searxngActionHandlers: Record<SearxngActionName, SearxngActionHandler> = {
  config: searxngGetAction(() => ({ path: searxngValidationPath })),
};

export async function validateSearxngCredential(
  input: { values: Record<string, string> },
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const baseUrl = normalizeSearxngBaseUrl(input.values.baseUrl);
  const payload = optionalRecord(
    await searxngRequest({ baseUrl, fetcher, signal, path: searxngValidationPath, phase: "validate" }),
  );

  // A real SearXNG instance answers `/config` with its engine/category catalog.
  // Guard against a stray 200 (an unrelated service or a health page) validating
  // green when the base URL does not actually point at SearXNG.
  if (!payload || (payload.engines === undefined && payload.categories === undefined)) {
    throw new ProviderRequestError(502, "unexpected response from SearXNG; check the base URL");
  }

  const host = new URL(baseUrl).host;
  return {
    profile: {
      accountId: `searxng:${host}`,
      displayName: `SearXNG (${host})`,
    },
    grantedScopes: [],
    metadata: compactObject({
      baseUrl,
      validationEndpoint: searxngValidationPath,
    }),
  };
}

/**
 * Parse the admin-configured self-hosted SearXNG base URL. Unlike public-target
 * providers, this deliberately permits http and private/`.internal` hosts and does
 * NOT call `assertPublicHttpUrl`: the value is set by an admin at connection time
 * (PUT /api/connections) and points at a co-located SearXNG instance. The
 * per-action query inputs are forwarded to SearXNG and never fetched by
 * open-connector, so relaxing this guard opens no new SSRF path. Mirrors
 * clickhouse's `normalizeClickhouseBaseUrl` and firecrawl_local's normalize.
 */
export function normalizeSearxngBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  const raw = trimmed && trimmed.length > 0 ? trimmed : defaultSearxngBaseUrl;

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

export function resolveSearxngBaseUrl(input: {
  values: Record<string, string>;
  metadata: Record<string, unknown>;
}): string {
  return normalizeSearxngBaseUrl(optionalString(input.metadata.baseUrl) ?? optionalString(input.values.baseUrl));
}

/**
 * Build an absolute SearXNG URL by concatenating the normalized base URL with the
 * endpoint path (preserving any instance sub-path) and serializing query params.
 */
export function buildSearxngUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    setSearchParams(url, query);
  }
  return url.toString();
}

interface SearxngRequestInput {
  baseUrl: string;
  fetcher: typeof fetch;
  path: string;
  phase: SearxngRequestPhase;
  signal?: AbortSignal;
  query?: Record<string, string | undefined>;
}

async function searxngRequest(input: SearxngRequestInput): Promise<unknown> {
  const url = buildSearxngUrl(input.baseUrl, input.path, input.query);
  // No Authorization header: the local path bypasses Cloudflare Access and
  // SearXNG runs with its limiter disabled.
  const headers = new Headers({ "user-agent": providerUserAgent });

  let response: Response;
  try {
    response = await input.fetcher(url, { method: "GET", headers, signal: input.signal });
  } catch (error) {
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `SearXNG request failed: ${error.message}` : "SearXNG request failed",
    );
  }

  const payload = await readSearxngPayload(response);
  if (!response.ok) {
    throw createSearxngError(response.status, payload, input.phase);
  }
  return payload;
}

function searxngGetAction(
  build: (input: Record<string, unknown>) => { path: string; query?: Record<string, string | undefined> },
): SearxngActionHandler {
  return (input, context) => {
    const { path, query } = build(input);
    return searxngRequest({
      baseUrl: context.baseUrl,
      fetcher: context.fetcher,
      signal: context.signal,
      path,
      query,
      phase: "execute",
    });
  };
}

async function readSearxngPayload(response: Response): Promise<unknown> {
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

function createSearxngError(status: number, payload: unknown, phase: SearxngRequestPhase): ProviderRequestError {
  const message = readSearxngErrorMessage(payload, status);
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

function readSearxngErrorMessage(payload: unknown, status: number): string {
  if (typeof payload === "string" && payload) {
    return payload;
  }
  const body = optionalRecord(payload);
  if (!body) {
    return `SearXNG request failed with ${status}`;
  }
  const directError =
    optionalString(body.error) ?? optionalString(optionalRecord(body.error)?.message) ?? optionalString(body.message);
  return directError ?? `SearXNG request failed with ${status}`;
}

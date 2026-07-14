import type { CredentialValidationResult } from "../../core/types.ts";
import type { EvermemActionName } from "./actions.ts";

import {
  compactObject,
  optionalBoolean,
  optionalIntegerLike,
  optionalRecord,
  optionalString,
  requiredString,
} from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import { createProviderTimeout, providerUserAgent, ProviderRequestError } from "../provider-runtime.ts";

// EverOS ships no authentication of its own; the bearer token is enforced by
// the reverse proxy in front of it. Validate against a cheap, parameter-free
// authenticated API path rather than `/health`, which proxies commonly leave
// open for liveness probes — so a wrong or empty bearer token is rejected (401
// at the proxy) instead of silently validating.
const evermemValidationPath = "/api/v1/knowledge/categories";

const memoryAddPath = "/api/v1/memory/add";
const memoryFlushPath = "/api/v1/memory/flush";

// Soft cap on the auto-flush leg of add_memory. Flush is a synchronous LLM
// extraction; the add is already durably buffered, so if extraction runs past
// this we stop waiting and report the flush as pending rather than blocking.
const flushTimeoutMs = 45_000;

// Default memory scope, mirroring the claude.ai EverMem MCP bridge so this
// provider reads and writes the same memory brain. Every field is overridable.
const defaultSessionId = "mcp-global";
const defaultUserId = "kedia";
const defaultAppId = "evermem";
const defaultProjectId = "global";

type EvermemRequestPhase = "validate" | "execute";
type EvermemQueryValue = string | number | boolean | undefined;

export interface EvermemActionContext {
  apiKey: string;
  baseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

type EvermemActionHandler = (input: Record<string, unknown>, context: EvermemActionContext) => Promise<unknown>;

/**
 * Action handlers keyed by the local action name (no service prefix). Entries
 * are added per implementation phase and must stay in sync with
 * `EvermemActionName` in actions.ts.
 */
export const evermemActionHandlers: Record<EvermemActionName, EvermemActionHandler> = {
  add_memory(input, context) {
    return addMemory(input, context);
  },
  flush_memory(input, context) {
    return requestFlush(resolveSessionScope(input), context);
  },
};

export async function validateEvermemCredential(
  input: { apiKey: string; values: Record<string, string> },
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const baseUrl = normalizeEvermemBaseUrl(input.values.baseUrl);
  await requestEvermemJson<unknown>({
    apiKey: input.apiKey,
    baseUrl,
    path: evermemValidationPath,
    fetcher,
    signal,
    phase: "validate",
  });

  const url = new URL(baseUrl);
  const instancePath = url.pathname === "/" ? "" : url.pathname;
  return {
    profile: {
      accountId: `evermem:${url.host}${instancePath}`,
      displayName: `EverOS (${url.host})`,
    },
    grantedScopes: [],
    metadata: compactObject({
      baseUrl,
      validationEndpoint: evermemValidationPath,
    }),
  };
}

// The EverOS request-body shape shared by the add and flush endpoints. Resolved
// straight into snake_case so it can be spread into request bodies verbatim.
type EvermemSessionScope = {
  session_id: string;
  app_id: string;
  project_id: string;
};

function resolveSessionScope(input: Record<string, unknown>): EvermemSessionScope {
  return {
    session_id: optionalString(input.sessionId) ?? defaultSessionId,
    app_id: optionalString(input.appId) ?? defaultAppId,
    project_id: optionalString(input.projectId) ?? defaultProjectId,
  };
}

async function addMemory(input: Record<string, unknown>, context: EvermemActionContext): Promise<unknown> {
  const scope = resolveSessionScope(input);
  const message = compactObject({
    sender_id: optionalString(input.userId) ?? defaultUserId,
    sender_name: optionalString(input.senderName),
    role: optionalString(input.role) ?? "user",
    timestamp: readOptionalPositiveInteger(input.timestamp, "timestamp") ?? Date.now(),
    content: requireInputString(input.content, "content"),
  });

  const { payload } = await requestEvermemJson<unknown>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path: memoryAddPath,
    method: "POST",
    body: { ...scope, messages: [message] },
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
  });
  const addResult = optionalRecord(unwrapData(payload)) ?? {};

  const autoFlush = optionalBoolean(input.autoFlush) ?? true;
  if (!autoFlush || optionalString(addResult.status) === "extracted") {
    return addResult;
  }

  // The message is already durably buffered by /memory/add. Bound the optional
  // flush with its own timeout, and if the flush fails or times out for ANY
  // reason, never fail the whole call — a retry would double-write the memory.
  // Report the flush as pending; EverOS extracts the buffered message later.
  const timeout = createProviderTimeout(context.signal, flushTimeoutMs);
  try {
    const flushResult = optionalRecord(await requestFlush(scope, { ...context, signal: timeout.signal })) ?? {};
    return compactObject({ ...addResult, flush_status: optionalString(flushResult.status) });
  } catch {
    return { ...addResult, flush_status: "pending" };
  } finally {
    timeout.cleanup();
  }
}

async function requestFlush(scope: EvermemSessionScope, context: EvermemActionContext): Promise<unknown> {
  const { payload } = await requestEvermemJson<unknown>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path: memoryFlushPath,
    method: "POST",
    body: scope,
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
  });
  return unwrapData(payload);
}

interface EvermemRequestInput {
  apiKey: string;
  baseUrl: string;
  path: string;
  fetcher: typeof fetch;
  phase: EvermemRequestPhase;
  signal?: AbortSignal;
  method?: string;
  query?: Record<string, EvermemQueryValue>;
  body?: Record<string, unknown>;
}

/**
 * Issue a request against EverOS and parse its JSON body. All EverOS responses
 * (except `/health` and DELETEs) use a `{ request_id, data }` envelope; callers
 * that need the payload unwrap `data` themselves.
 */
export async function requestEvermemJson<T>(input: EvermemRequestInput): Promise<{ payload: T }> {
  const response = await evermemFetch(input);
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw toEvermemError(response, payload, input.phase);
  }
  return { payload: payload as T };
}

async function evermemFetch(input: EvermemRequestInput): Promise<Response> {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${input.apiKey}`,
    "User-Agent": providerUserAgent,
  });

  let body: string | undefined;
  if (input.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(input.body);
  }

  return input.fetcher(buildEvermemApiUrl(input.baseUrl, input.path, input.query), {
    method: input.method ?? "GET",
    headers,
    body,
    signal: input.signal,
  });
}

/**
 * Build an absolute EverOS API URL by concatenating the normalized base URL
 * with the endpoint path, preserving any instance sub-path.
 */
export function buildEvermemApiUrl(baseUrl: string, path: string, query?: Record<string, EvermemQueryValue>): string {
  const url = new URL(`${baseUrl}${ensureLeadingSlash(path)}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Normalize a user-configured EverOS base URL. The API is https-only, and any
 * instance sub-path is preserved (endpoints such as `/api/v1/memory/add` and
 * `/health` are appended to it). No fixed API prefix is added here.
 */
export function normalizeEvermemBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ProviderRequestError(400, "Base URL is required");
  }

  const parsed = assertPublicHttpUrl(trimmed, {
    fieldName: "baseUrl",
    createError: (message) => new ProviderRequestError(400, message),
  });

  if (parsed.protocol !== "https:") {
    throw new ProviderRequestError(400, "Base URL must use https");
  }

  parsed.search = "";
  parsed.hash = "";

  let pathname = parsed.pathname;
  while (pathname.endsWith("/") && pathname !== "/") {
    pathname = pathname.slice(0, -1);
  }

  return pathname === "/" ? parsed.origin : `${parsed.origin}${pathname}`;
}

export function resolveEvermemBaseUrl(input: {
  values: Record<string, string>;
  metadata: Record<string, unknown>;
}): string {
  const baseUrl = optionalString(input.metadata.baseUrl) ?? optionalString(input.values.baseUrl);
  if (!baseUrl) {
    throw new ProviderRequestError(500, "evermem provider metadata is missing baseUrl");
  }
  return normalizeEvermemBaseUrl(baseUrl);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function toEvermemError(response: Response, payload: unknown, phase: EvermemRequestPhase): ProviderRequestError {
  const message = extractEvermemMessage(payload) ?? `evermem request failed with ${response.status}`;

  if (response.status === 429) {
    return new ProviderRequestError(429, message, payload);
  }
  if (response.status === 401) {
    return new ProviderRequestError(phase === "validate" ? 400 : 401, message, payload);
  }
  if (response.status === 403) {
    return new ProviderRequestError(phase === "validate" ? 400 : 403, message, payload);
  }
  if ([400, 404, 409, 415, 422].includes(response.status)) {
    return new ProviderRequestError(response.status === 404 ? 404 : 400, message, payload);
  }

  return new ProviderRequestError(response.status || 502, message, payload);
}

function extractEvermemMessage(payload: unknown): string | undefined {
  const record = optionalRecord(payload);
  if (!record) {
    return undefined;
  }

  const error = optionalRecord(record.error);
  if (error) {
    return optionalString(error.message) ?? optionalString(error.code);
  }

  return optionalString(record.message) ?? optionalString(record.detail);
}

/** Unwrap the `{ request_id, data }` envelope EverOS wraps its responses in. */
function unwrapData(payload: unknown): unknown {
  const record = optionalRecord(payload);
  return record && record.data !== undefined ? record.data : payload;
}

function requireInputString(value: unknown, fieldName: string): string {
  return requiredString(value, fieldName, (message) => new ProviderRequestError(400, message));
}

function readOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  const parsed = optionalIntegerLike(value, fieldName, (message) => new ProviderRequestError(400, message));
  if (parsed !== undefined && parsed <= 0) {
    throw new ProviderRequestError(400, `${fieldName} must be a positive integer`);
  }
  return parsed;
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

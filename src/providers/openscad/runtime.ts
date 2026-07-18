import type { CredentialValidationResult, TransitFileWriter } from "../../core/types.ts";
import type { OpenscadActionName } from "./actions.ts";

import { compactObject, optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { readBoundedResponseBytes } from "../../core/request.ts";
import { ProviderRequestError, providerUserAgent } from "../provider-runtime.ts";

// Both the connector container and the self-hosted OpenSCAD render microservice
// run in the same OrbStack host, so the default targets the renderer over the
// host gateway with no tunnel and no auth. Mirrors searxng/firecrawl_local.
export const defaultOpenscadBaseUrl = "http://host.docker.internal:8910";

const openscadHealthPath = "/health";
const openscadRenderPath = "/render";

export interface OpenscadActionContext {
  baseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  transitFiles?: TransitFileWriter;
}

type OpenscadActionHandler = (input: Record<string, unknown>, context: OpenscadActionContext) => Promise<unknown>;

/**
 * Action handlers keyed by the local action name (no service prefix). Must stay
 * in sync with `OpenscadActionName` in actions.ts.
 */
export const openscadActionHandlers: Record<OpenscadActionName, OpenscadActionHandler> = {
  info: (_input, context) => openscadGetJson(context, openscadHealthPath),
  render_model: (input, context) => renderToTransit(input, context, optionalString(input.format) ?? "stl", false),
  render_2d: (input, context) =>
    renderToTransit(input, context, requiredString(input.format, "format", invalidInput), false),
  render_preview: (input, context) => renderToTransit(input, context, "png", true),
};

/**
 * Parse the admin-configured self-hosted render base URL. Like searxng, this
 * deliberately permits http and private/`.internal` hosts and does NOT apply an
 * SSRF guard: the value is set by an admin at connection time and points at a
 * co-located OpenSCAD render service.
 */
export function normalizeOpenscadBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  const raw = trimmed && trimmed.length > 0 ? trimmed : defaultOpenscadBaseUrl;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderRequestError(400, "baseUrl must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderRequestError(400, "baseUrl must use http or https");
  }

  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

export function resolveOpenscadBaseUrl(input: {
  values: Record<string, string>;
  metadata: Record<string, unknown>;
}): string {
  return normalizeOpenscadBaseUrl(optionalString(input.metadata.baseUrl) ?? optionalString(input.values.baseUrl));
}

export async function validateOpenscadCredential(
  input: { values: Record<string, string> },
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const baseUrl = normalizeOpenscadBaseUrl(input.values.baseUrl);
  const payload = optionalRecord(await openscadGetJson({ baseUrl, fetcher, signal }, openscadHealthPath));

  // A real render service answers /health with {ok:true, version}. Guard against
  // a stray 200 from an unrelated service validating green.
  if (!payload || payload.ok !== true) {
    throw new ProviderRequestError(502, "unexpected response from the OpenSCAD render service; check the base URL");
  }

  const host = new URL(baseUrl).host;
  return {
    profile: {
      accountId: `openscad:${host}`,
      displayName: `OpenSCAD (${host})`,
    },
    grantedScopes: [],
    metadata: compactObject({
      baseUrl,
      version: optionalString(payload.version),
    }),
  };
}

async function renderToTransit(
  input: Record<string, unknown>,
  context: OpenscadActionContext,
  format: string,
  isPreview: boolean,
): Promise<unknown> {
  if (!context.transitFiles) {
    throw new ProviderRequestError(400, "Transit file storage is not enabled.");
  }

  const source = requiredString(input.source, "source", invalidInput);
  const params = optionalRecord(input.params);
  const body = isPreview
    ? compactObject({
        source,
        format: "png",
        params,
        imgsize: optionalString(input.imgsize),
        camera: optionalString(input.camera),
        colorscheme: optionalString(input.colorscheme),
        projection: optionalString(input.projection),
      })
    : compactObject({ source, format, params });

  const response = await openscadPost(context, openscadRenderPath, body);
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: context.transitFiles.maxBytes,
    fieldName: `rendered ${format}`,
    createError: (message) => new ProviderRequestError(413, message),
  });

  // The render service always sets Content-Type; fall back only if it somehow does not.
  const mimetype = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  const name = `${sanitizeFilename(optionalString(input.filename))}.${format}`;
  const upload = await context.transitFiles.create(new File([Uint8Array.from(bytes)], name, { type: mimetype }));

  const file = {
    name,
    mimetype,
    downloadUrl: upload.downloadUrl,
    fileId: upload.fileId,
    sizeBytes: upload.sizeBytes,
  };
  return isPreview ? { file } : { format, file };
}

function sanitizeFilename(value: string | undefined): string {
  const base = (value ?? "openscad").replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^[._]+/u, "");
  return base || "openscad";
}

/** Issue a request to the render service, normalizing transport failures to 502. */
async function openscadFetch(
  context: Pick<OpenscadActionContext, "baseUrl" | "fetcher" | "signal">,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const url = new URL(`${context.baseUrl}${path}`).toString();
  try {
    return await context.fetcher(url, { ...init, signal: context.signal });
  } catch (error) {
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `OpenSCAD request failed: ${error.message}` : "OpenSCAD request failed",
    );
  }
}

async function openscadPost(
  context: OpenscadActionContext,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const response = await openscadFetch(context, path, {
    method: "POST",
    headers: new Headers({ "user-agent": providerUserAgent, "content-type": "application/json", accept: "*/*" }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ProviderRequestError(response.status || 502, await readOpenscadError(response));
  }
  return response;
}

async function openscadGetJson(
  context: Pick<OpenscadActionContext, "baseUrl" | "fetcher" | "signal">,
  path: string,
): Promise<unknown> {
  const response = await openscadFetch(context, path, {
    method: "GET",
    headers: new Headers({ "user-agent": providerUserAgent, accept: "application/json" }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ProviderRequestError(response.status || 502, text || `OpenSCAD request failed with ${response.status}`);
  }
  return safeJsonParse(text) ?? {};
}

/** The render service reports errors as JSON `{ "error": "..." }` or plain text. */
async function readOpenscadError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return `OpenSCAD render failed with HTTP ${response.status}`;
  }
  return optionalString(optionalRecord(safeJsonParse(text))?.error) ?? text;
}

function safeJsonParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function invalidInput(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

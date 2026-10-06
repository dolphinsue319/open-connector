import type { ProviderFetch } from "../provider-runtime.ts";

import { optionalRecord, optionalString } from "../../core/cast.ts";
import {
  providerInputError,
  ProviderRequestError,
  providerUserAgent,
  runProviderRequest,
} from "../provider-runtime.ts";

/**
 * Google HTTP plumbing for this provider.
 *
 * Upstream removed the shared `src/providers/google-runtime.ts` in ff9f87b1 and gave each Google
 * provider its own copy (see `googledrive/runtime-request.ts`), so this is where the Admin SDK
 * calls get their bearer header, timeout, and error shape.
 */

const requestLabel = "Google Workspace Admin";

export interface GoogleRequestOptions {
  accessToken: string;
  fetcher: ProviderFetch;
  signal?: AbortSignal;
  method?: string;
  body?: unknown;
}

export async function googleJsonRequest<T>(url: string, input: GoogleRequestOptions): Promise<T> {
  const response = await googleRequest(url, input);
  return (await response.json()) as T;
}

export async function googleRequest(url: string, input: GoogleRequestOptions): Promise<Response> {
  const hasJsonBody = input.body !== undefined;
  const method = (input.method ?? (hasJsonBody ? "POST" : "GET")).toUpperCase();
  if ((method === "GET" || method === "HEAD") && hasJsonBody) {
    throw providerInputError(`${requestLabel} ${method} request must not include a body`);
  }

  const response = await runProviderRequest({ signal: input.signal, label: requestLabel }, (signal) =>
    input.fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "user-agent": providerUserAgent,
        ...(hasJsonBody ? { "content-type": "application/json" } : {}),
      },
      body: hasJsonBody ? JSON.stringify(input.body) : undefined,
      signal,
    }),
  );

  if (!response.ok) {
    const { message, details } = await extractGoogleError(response);
    throw new ProviderRequestError(response.status, message, details);
  }
  return response;
}

/** Google reports Admin SDK failures as `{ error: { message } }`; fall back to the raw body. */
async function extractGoogleError(response: Response): Promise<{ message: string; details: unknown }> {
  const rawText = await response.text().catch(() => "");
  if (!rawText) {
    return {
      message: `${requestLabel} request failed with ${response.status}`,
      details: { status: response.status },
    };
  }

  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const error = optionalRecord(parsed.error);
    return {
      message: optionalString(error?.message) ?? optionalString(parsed.error_description) ?? rawText,
      details: parsed,
    };
  } catch {
    return { message: rawText, details: rawText };
  }
}

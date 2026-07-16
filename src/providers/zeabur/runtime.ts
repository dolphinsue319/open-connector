import type { CredentialValidationResult } from "../../core/types.ts";
import type { ApiKeyProviderContext } from "../provider-runtime.ts";
import type { ZeaburActionName } from "./actions.ts";

import { compactObject, optionalRecord, optionalString } from "../../core/cast.ts";
import {
  createProviderTimeout,
  isAbortLikeError,
  ProviderRequestError,
  providerUserAgent,
} from "../provider-runtime.ts";

export const zeaburApiUrl = "https://api.zeabur.com/graphql";
const defaultTimeoutMs = 30_000;

type ZeaburRequestPhase = "validate" | "execute";
type ZeaburContext = Pick<ApiKeyProviderContext, "apiKey" | "fetcher" | "signal">;
type ZeaburActionHandler = (input: Record<string, unknown>, context: ApiKeyProviderContext) => Promise<unknown>;

type ZeaburGraphqlError = { message?: unknown; extensions?: unknown };
type ZeaburGraphqlEnvelope<TData> = {
  data?: TData | null;
  errors?: ZeaburGraphqlError[];
  message?: unknown;
};

interface ZeaburGraphqlInput {
  query: string;
  variables?: Record<string, unknown>;
  phase?: ZeaburRequestPhase;
}

/**
 * Hide a secret value while leaving enough of it to recognise which key it is.
 *
 * Values of 8 characters or fewer are masked entirely: revealing a head and
 * tail of a short secret would leave too little unknown.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "…";
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

export async function validateZeaburCredential(
  input: { apiKey: string },
  options: { fetcher: typeof fetch; signal?: AbortSignal },
): Promise<CredentialValidationResult> {
  const data = await zeaburGraphqlRequest<{ me?: Record<string, unknown> }>(
    { apiKey: input.apiKey, fetcher: options.fetcher, signal: options.signal },
    { query: `query { me { _id name username email } }`, phase: "validate" },
  );
  const me = optionalRecord(data.me);
  const accountId = optionalString(me?._id);
  if (!accountId) {
    throw new ProviderRequestError(502, "Zeabur did not return the current user.");
  }
  const username = optionalString(me?.username);
  const email = optionalString(me?.email);

  return {
    profile: {
      accountId,
      displayName: optionalString(me?.name) ?? username ?? email ?? accountId,
    },
    grantedScopes: [],
    metadata: compactObject({ apiBaseUrl: zeaburApiUrl, username, email }),
  };
}

export async function zeaburGraphqlRequest<TData>(context: ZeaburContext, input: ZeaburGraphqlInput): Promise<TData> {
  const phase = input.phase ?? "execute";
  const timeout = createProviderTimeout(context.signal, defaultTimeoutMs);
  let response: Response;
  try {
    response = await context.fetcher(zeaburApiUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${context.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": providerUserAgent,
      },
      body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
      signal: timeout.signal,
    });
  } catch (error) {
    if (timeout.didTimeout() || isAbortLikeError(error)) {
      throw new ProviderRequestError(
        504,
        `Zeabur request timed out after ${Math.ceil(defaultTimeoutMs / 1000)} seconds`,
      );
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `Zeabur request failed: ${error.message}` : "Zeabur request failed",
      error,
    );
  } finally {
    timeout.cleanup();
  }

  const payload = await readGraphqlEnvelope<TData>(response);
  if (!response.ok) {
    throw buildZeaburError(response.status, payload, phase);
  }
  // GraphQL reports failures with HTTP 200, so a non-empty errors array still means the call failed.
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw buildZeaburError(statusFromGraphqlError(payload.errors[0]), payload, phase);
  }
  if (payload.data == null) {
    throw new ProviderRequestError(502, "Zeabur response did not include data");
  }

  return payload.data;
}

async function readGraphqlEnvelope<TData>(response: Response): Promise<ZeaburGraphqlEnvelope<TData>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as ZeaburGraphqlEnvelope<TData>;
  } catch {
    throw new ProviderRequestError(502, "Zeabur returned invalid JSON");
  }
}

function buildZeaburError(status: number | undefined, payload: unknown, phase: ZeaburRequestPhase): ProviderRequestError {
  const message = extractErrorMessage(payload) ?? `Zeabur request failed with ${status ?? 500}`;
  if (status === 429) {
    return new ProviderRequestError(429, message, payload);
  }
  // While validating, the user is fixing their key: report a bad token as invalid input, not as an auth failure.
  if (phase === "validate" && (status === 401 || status === 403)) {
    return new ProviderRequestError(400, message, payload);
  }
  if (status !== undefined && status >= 400) {
    return new ProviderRequestError(status, message, payload);
  }
  return new ProviderRequestError(502, message, payload);
}

/**
 * Zeabur puts the human-readable message at the envelope top level and leaves
 * `errors[].message` unset, so fall back through both shapes.
 */
function extractErrorMessage(payload: unknown): string | undefined {
  const envelope = optionalRecord(payload);
  if (!envelope) return undefined;
  const firstError = optionalRecord(Array.isArray(envelope.errors) ? envelope.errors[0] : undefined);
  return optionalString(firstError?.message) ?? optionalString(envelope.message);
}

function statusFromGraphqlError(error: ZeaburGraphqlError | undefined): number | undefined {
  const extensions = optionalRecord(error?.extensions);
  const code = optionalString(extensions?.code);
  if (code === "ERROR_INVALID_TOKEN" || code === "ERROR_UNAUTHORIZED") return 401;
  if (code === "ERROR_PERMISSION_DENIED") return 403;
  if (code === "ERROR_NOT_FOUND") return 404;
  return undefined;
}

const projectFields = `
  _id
  name
  description
  createdAt
  region { id }
  environments { _id name }
  services { _id name template }
`;

function normalizeProject(value: unknown): Record<string, unknown> {
  const project = optionalRecord(value) ?? {};
  return compactObject({
    id: optionalString(project._id),
    name: optionalString(project.name),
    description: optionalString(project.description),
    createdAt: optionalString(project.createdAt),
    region: optionalString(optionalRecord(project.region)?.id),
    environments: asArray(project.environments).map((environment) => normalizeEnvironment(environment)),
    services: asArray(project.services).map((service) => normalizeServiceRef(service)),
  });
}

function normalizeEnvironment(value: unknown): Record<string, unknown> {
  const environment = optionalRecord(value) ?? {};
  return compactObject({
    id: optionalString(environment._id),
    name: optionalString(environment.name),
  });
}

function normalizeServiceRef(value: unknown): Record<string, unknown> {
  const service = optionalRecord(value) ?? {};
  return compactObject({
    id: optionalString(service._id),
    name: optionalString(service.name),
    template: optionalString(service.template),
  });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export const zeaburActionHandlers: Record<ZeaburActionName, ZeaburActionHandler> = {
  async list_projects(input, context) {
    const data = await zeaburGraphqlRequest<{ projects?: { edges?: unknown[] } }>(context, {
      query: `query ListProjects($skip: Int, $limit: Int) {
        projects(skip: $skip, limit: $limit) {
          edges { node { ${projectFields} } }
        }
      }`,
      variables: { skip: input.skip, limit: input.limit },
    });
    const edges = asArray(data.projects?.edges);
    return { projects: edges.map((edge) => normalizeProject(optionalRecord(edge)?.node)) };
  },
};

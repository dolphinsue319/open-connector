import type { CredentialValidationResult } from "../../core/types.ts";
import type { ApiKeyProviderContext } from "../provider-runtime.ts";
import type { ZeaburActionName } from "./actions.ts";

import { compactObject, optionalRawString, optionalRecord, optionalString } from "../../core/cast.ts";
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

const previewHead = 3;
const previewTail = 4;
const previewLength = previewHead + previewTail;
// Reveal at most a third of a value, so what stays hidden always dominates what leaks.
const shortestPreviewable = previewLength * 3;

/**
 * Hide a secret value while leaving enough of it to tell which one it is.
 *
 * The preview is a fixed 7 characters, so it only stays a minority of short
 * values up to a point: previewing a 10-character password would disclose 7 of
 * it while still reporting masked. Anything below three times the preview is
 * masked whole instead — the key name already identifies the variable, so a
 * preview only has to confirm the shape of a long credential.
 */
export function maskSecret(value: string): string {
  if (value.length < shortestPreviewable) return "…";
  return `${value.slice(0, previewHead)}…${value.slice(-previewTail)}`;
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

function buildZeaburError(
  status: number | undefined,
  payload: unknown,
  phase: ZeaburRequestPhase,
): ProviderRequestError {
  const message = extractErrorMessage(payload) ?? `Zeabur request failed with ${status ?? 500}`;
  const details = errorDetails(payload);
  if (status === 429) {
    return new ProviderRequestError(429, message, details);
  }
  // While validating, the user is fixing their key: report a bad token as invalid input, not as an auth failure.
  if (phase === "validate" && (status === 401 || status === 403)) {
    return new ProviderRequestError(400, message, details);
  }
  if (status !== undefined && status >= 400) {
    return new ProviderRequestError(status, message, details);
  }
  return new ProviderRequestError(502, message, details);
}

/**
 * Keep `data` out of error details.
 *
 * GraphQL answers a partial failure with data and errors together, and the
 * shared runtime copies these details straight back to the caller. Passing the
 * whole envelope would hand back whatever the query selected — for
 * list_env_vars, every plaintext secret — on a path where maskSecret never
 * runs. Only the errors describe the failure, so only they belong here.
 */
function errorDetails(payload: unknown): unknown {
  const envelope = optionalRecord(payload);
  const errors = envelope?.errors;
  return Array.isArray(errors) ? { errors } : undefined;
}

/**
 * Zeabur reports failures in three places: auth errors put the text at the
 * envelope top level and leave `errors[].message` unset, while operation errors
 * fill `errors[].message` with a terse summary and put the actionable reason in
 * `extensions.description` ("Advanced log search requires Pro or Team plan").
 * Merge the summary and the description so callers get the whole story.
 */
function extractErrorMessage(payload: unknown): string | undefined {
  const envelope = optionalRecord(payload);
  if (!envelope) return undefined;
  const firstError = optionalRecord(Array.isArray(envelope.errors) ? envelope.errors[0] : undefined);
  const summary = optionalString(firstError?.message) ?? optionalString(envelope.message);
  const description = optionalString(optionalRecord(firstError?.extensions)?.description);
  if (summary && description) return `${summary}: ${description}`;
  return summary ?? description;
}

function statusFromGraphqlError(error: ZeaburGraphqlError | undefined): number | undefined {
  const extensions = optionalRecord(error?.extensions);
  const code = optionalString(extensions?.code);
  if (code === "ERROR_INVALID_TOKEN" || code === "ERROR_UNAUTHORIZED") return 401;
  if (code === "PERMISSION_DENIED" || code === "ERROR_PERMISSION_DENIED") return 403;
  if (code === "ERROR_NOT_FOUND") return 404;
  if (code === "GRAPHQL_VALIDATION_FAILED" || code === "BAD_USER_INPUT") return 400;
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

const serviceFields = `
  _id
  name
  template
  dnsName
  createdAt
`;

const deploymentFields = `
  _id
  status
  ref
  commitSHA
  commitMessage
  createdAt
  finishedAt
`;

const runtimeLogFields = `
  message
  timestamp
  stream
  region
`;

function normalizeService(value: unknown): Record<string, unknown> {
  const service = optionalRecord(value) ?? {};
  return compactObject({
    id: optionalString(service._id),
    name: optionalString(service.name),
    template: optionalString(service.template),
    dnsName: optionalString(service.dnsName),
    createdAt: optionalString(service.createdAt),
    status: optionalString(service.status),
  });
}

function normalizeDeployment(edge: unknown): Record<string, unknown> {
  const record = optionalRecord(edge) ?? {};
  const node = optionalRecord(record.node) ?? {};
  return compactObject({
    id: optionalString(node._id),
    status: optionalString(node.status),
    ref: optionalString(node.ref),
    commitSHA: optionalString(node.commitSHA),
    commitMessage: optionalString(node.commitMessage),
    createdAt: optionalString(node.createdAt),
    finishedAt: optionalString(node.finishedAt),
    cursor: optionalString(record.cursor),
  });
}

function normalizeLog(value: unknown): Record<string, unknown> {
  const log = optionalRecord(value) ?? {};
  return compactObject({
    message: optionalString(log.message),
    timestamp: optionalString(log.timestamp),
    stream: optionalString(log.stream),
    region: optionalString(log.region),
  });
}

function normalizeEnvVar(value: unknown, reveal: boolean): Record<string, unknown> {
  const variable = optionalRecord(value) ?? {};
  // Read the value raw. optionalString trims, which would hand back a PEM key stripped of its
  // trailing newline — a value that silently no longer works wherever it gets pasted.
  const raw = optionalRawString(variable.value) ?? "";
  return compactObject({
    key: optionalString(variable.key),
    ...(reveal ? { value: raw } : { valuePreview: maskSecret(raw) }),
    masked: !reveal,
    exposed: variable.exposed === true,
    readonly: variable.readonly === true,
  });
}

const listEnvVarsQuery = `query ListEnvVars($id: ObjectID, $environmentId: ObjectID!) {
  service(_id: $id) {
    variables(environmentID: $environmentId) { key value exposed readonly }
  }
}`;

// set_env_var only needs to know which names exist. Selecting `value` here would pull every
// plaintext secret across the wire on every write, for a check that throws them away.
const listEnvVarKeysQuery = `query ListEnvVarKeys($id: ObjectID, $environmentId: ObjectID!) {
  service(_id: $id) {
    variables(environmentID: $environmentId) { key }
  }
}`;

async function readEnvVars(
  context: ApiKeyProviderContext,
  target: { serviceId: unknown; environmentId: unknown },
  query: string = listEnvVarsQuery,
): Promise<unknown[]> {
  const data = await zeaburGraphqlRequest<{ service?: { variables?: unknown[] } }>(context, {
    query,
    variables: { id: target.serviceId, environmentId: target.environmentId },
  });
  return asArray(data.service?.variables);
}

async function readEnvVarKeys(
  context: ApiKeyProviderContext,
  target: { serviceId: unknown; environmentId: unknown },
): Promise<string[]> {
  const variables = await readEnvVars(context, target, listEnvVarKeysQuery);
  return variables
    .map((variable) => optionalString(optionalRecord(variable)?.key))
    .filter((key): key is string => key !== undefined);
}

/**
 * Count the variables on a service, or return undefined if the count cannot be read.
 *
 * Only for reporting after a write that already committed: the write is done and
 * cannot be undone, so a failure here means the count is unknown, not that the
 * write failed. Throwing would tell the caller the opposite of what happened.
 */
async function countEnvVars(
  context: ApiKeyProviderContext,
  target: { serviceId: unknown; environmentId: unknown },
): Promise<number | undefined> {
  try {
    return (await readEnvVarKeys(context, target)).length;
  } catch {
    return undefined;
  }
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

  async get_project(input, context) {
    const data = await zeaburGraphqlRequest<{ project?: unknown }>(context, {
      query: `query GetProject($id: ObjectID, $owner: String, $name: String) {
        project(_id: $id, owner: $owner, name: $name) { ${projectFields} }
      }`,
      variables: { id: input.projectId, owner: input.owner, name: input.name },
    });
    return normalizeProject(data.project);
  },

  async list_services(input, context) {
    const data = await zeaburGraphqlRequest<{ services?: { edges?: unknown[] } }>(context, {
      query: `query ListServices($projectId: ObjectID, $skip: Int, $limit: Int) {
        services(projectID: $projectId, skip: $skip, limit: $limit) {
          edges { node { ${serviceFields} } }
        }
      }`,
      variables: { projectId: input.projectId, skip: input.skip, limit: input.limit },
    });
    const edges = asArray(data.services?.edges);
    return { services: edges.map((edge) => normalizeService(optionalRecord(edge)?.node)) };
  },

  async get_service(input, context) {
    const data = await zeaburGraphqlRequest<{ service?: unknown }>(context, {
      query: `query GetService($id: ObjectID, $environmentId: ObjectID!) {
        service(_id: $id) {
          ${serviceFields}
          status(environmentID: $environmentId)
        }
      }`,
      variables: { id: input.serviceId, environmentId: input.environmentId },
    });
    return normalizeService(data.service);
  },

  async list_environments(input, context) {
    const data = await zeaburGraphqlRequest<{ environments?: unknown[] }>(context, {
      query: `query ListEnvironments($projectId: ObjectID!) {
        environments(projectID: $projectId) { _id name }
      }`,
      variables: { projectId: input.projectId },
    });
    return { environments: asArray(data.environments).map((environment) => normalizeEnvironment(environment)) };
  },

  async list_deployments(input, context) {
    // DeploymentConnection exposes only edges — it has no pageInfo, unlike the other connections.
    const data = await zeaburGraphqlRequest<{ deployments?: { edges?: unknown[] } }>(context, {
      query: `query ListDeployments(
        $serviceId: ObjectID!
        $environmentId: ObjectID!
        $cursor: String
        $perPage: Int
        $filter: DeploymentStatus
      ) {
        deployments(
          serviceID: $serviceId
          environmentID: $environmentId
          cursor: $cursor
          perPage: $perPage
          filter: $filter
        ) {
          edges { cursor node { ${deploymentFields} } }
        }
      }`,
      variables: {
        serviceId: input.serviceId,
        environmentId: input.environmentId,
        cursor: input.cursor,
        perPage: input.perPage,
        filter: input.filter,
      },
    });
    return { deployments: asArray(data.deployments?.edges).map((edge) => normalizeDeployment(edge)) };
  },

  async list_env_vars(input, context) {
    const reveal = input.reveal === true;
    const variables = await readEnvVars(context, {
      serviceId: input.serviceId,
      environmentId: input.environmentId,
    });
    return { variables: variables.map((variable) => normalizeEnvVar(variable, reveal)) };
  },

  async get_build_logs(input, context) {
    const data = await zeaburGraphqlRequest<{ buildLogs?: unknown[] }>(context, {
      query: `query BuildLogs($deploymentId: ObjectID!, $projectId: ObjectID, $timestampCursor: Time) {
        buildLogs(deploymentID: $deploymentId, projectID: $projectId, timestampCursor: $timestampCursor) {
          message
          timestamp
        }
      }`,
      variables: {
        deploymentId: input.deploymentId,
        projectId: input.projectId,
        timestampCursor: input.timestampCursor,
      },
    });
    return { logs: asArray(data.buildLogs).map((log) => normalizeLog(log)) };
  },

  async get_runtime_logs(input, context) {
    const data = await zeaburGraphqlRequest<{ runtimeLogs?: unknown[] }>(context, {
      query: `query RuntimeLogs(
        $serviceId: ObjectID!
        $environmentId: ObjectID
        $deploymentId: ObjectID
        $timestampCursor: Time
      ) {
        runtimeLogs(
          serviceID: $serviceId
          environmentID: $environmentId
          deploymentID: $deploymentId
          timestampCursor: $timestampCursor
        ) { ${runtimeLogFields} }
      }`,
      variables: {
        serviceId: input.serviceId,
        environmentId: input.environmentId,
        deploymentId: input.deploymentId,
        timestampCursor: input.timestampCursor,
      },
    });
    return { logs: asArray(data.runtimeLogs).map((log) => normalizeLog(log)) };
  },

  async search_runtime_logs(input, context) {
    const data = await zeaburGraphqlRequest<{ searchRuntimeLogs?: unknown[] }>(context, {
      query: `query SearchRuntimeLogs(
        $serviceId: ObjectID!
        $environmentId: ObjectID
        $deploymentId: ObjectID
        $query: String!
        $limit: Int
        $startTime: Time
        $endTime: Time
      ) {
        searchRuntimeLogs(
          serviceID: $serviceId
          environmentID: $environmentId
          deploymentID: $deploymentId
          query: $query
          limit: $limit
          startTime: $startTime
          endTime: $endTime
        ) { ${runtimeLogFields} }
      }`,
      variables: {
        serviceId: input.serviceId,
        environmentId: input.environmentId,
        deploymentId: input.deploymentId,
        query: input.query,
        limit: input.limit,
        startTime: input.startTime,
        endTime: input.endTime,
      },
    });
    return { logs: asArray(data.searchRuntimeLogs).map((log) => normalizeLog(log)) };
  },

  async set_env_var(input, context) {
    const target = { serviceId: input.serviceId, environmentId: input.environmentId };
    const existing = await readEnvVarKeys(context, target);
    // Trim to match: readEnvVarKeys returns trimmed names, so an untrimmed "API_KEY " would miss the
    // stored "API_KEY", create a near-duplicate, and leave the real variable serving its old value.
    // Environment variable names cannot carry surrounding whitespace anyway.
    const key = String(input.key).trim();

    if (existing.includes(key)) {
      const data = await zeaburGraphqlRequest<{ updateSingleEnvironmentVariable?: unknown[] }>(context, {
        query: `mutation SetEnvVar(
          $serviceId: ObjectID!
          $environmentId: ObjectID!
          $oldKey: String!
          $newKey: String!
          $value: String!
        ) {
          updateSingleEnvironmentVariable(
            serviceID: $serviceId
            environmentID: $environmentId
            oldKey: $oldKey
            newKey: $newKey
            value: $value
          ) { key }
        }`,
        variables: { ...target, oldKey: key, newKey: key, value: input.value },
      });
      return { key, created: false, variableCount: asArray(data.updateSingleEnvironmentVariable).length };
    }

    await zeaburGraphqlRequest<{ createEnvironmentVariable?: unknown }>(context, {
      query: `mutation CreateEnvVar($serviceId: ObjectID!, $environmentId: ObjectID!, $key: String!, $value: String!) {
        createEnvironmentVariable(serviceID: $serviceId, environmentID: $environmentId, key: $key, value: $value) { key }
      }`,
      variables: { ...target, key, value: input.value },
    });
    // createEnvironmentVariable returns only the new variable, so re-read to report an observed count
    // rather than assuming the rest of the set survived. The write has already committed at this
    // point, so a failed re-read must not surface as a failed write — report without the count.
    return compactObject({ key, created: true, variableCount: await countEnvVars(context, target) });
  },

  async delete_env_var(input, context) {
    const key = String(input.key).trim();
    const data = await zeaburGraphqlRequest<{ deleteSingleEnvironmentVariable?: unknown[] }>(context, {
      query: `mutation DeleteEnvVar($serviceId: ObjectID!, $environmentId: ObjectID!, $key: String!) {
        deleteSingleEnvironmentVariable(serviceID: $serviceId, environmentID: $environmentId, key: $key) { key }
      }`,
      variables: { serviceId: input.serviceId, environmentId: input.environmentId, key },
    });
    // The mutation answers with the variables that survive, so report whether the key is really gone
    // instead of assuming a non-error response means it was there to delete.
    const remaining = asArray(data.deleteSingleEnvironmentVariable).map((variable) =>
      optionalString(optionalRecord(variable)?.key),
    );
    return { key, deleted: !remaining.includes(key), variableCount: remaining.length };
  },

  async restart_service(input, context) {
    const data = await zeaburGraphqlRequest<{ restartService?: unknown }>(context, {
      query: `mutation RestartService($serviceId: ObjectID!, $environmentId: ObjectID!) {
        restartService(serviceID: $serviceId, environmentID: $environmentId)
      }`,
      variables: { serviceId: input.serviceId, environmentId: input.environmentId },
    });
    return { success: data.restartService === true };
  },

  async redeploy_service(input, context) {
    const data = await zeaburGraphqlRequest<{ redeployService?: unknown }>(context, {
      query: `mutation RedeployService($serviceId: ObjectID!, $environmentId: ObjectID!) {
        redeployService(serviceID: $serviceId, environmentID: $environmentId)
      }`,
      variables: { serviceId: input.serviceId, environmentId: input.environmentId },
    });
    return { success: data.redeployService === true };
  },

  async update_service_image_tag(input, context) {
    const data = await zeaburGraphqlRequest<{ updateServiceImageTag?: unknown }>(context, {
      query: `mutation UpdateServiceImageTag($serviceId: ObjectID!, $environmentId: ObjectID!, $tag: String!) {
        updateServiceImageTag(serviceID: $serviceId, environmentID: $environmentId, tag: $tag)
      }`,
      variables: { serviceId: input.serviceId, environmentId: input.environmentId, tag: input.tag },
    });
    return { success: data.updateServiceImageTag === true };
  },

  async rollback_deployment(input, context) {
    const data = await zeaburGraphqlRequest<{ rollbackDeployment?: unknown }>(context, {
      query: `mutation RollbackDeployment($deploymentId: ObjectID!) {
        rollbackDeployment(deploymentID: $deploymentId)
      }`,
      variables: { deploymentId: input.deploymentId },
    });
    return { success: data.rollbackDeployment === true };
  },
};

import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { GitlabActionName } from "./actions.ts";

import {
  compactObject,
  optionalBoolean,
  optionalIntegerLike,
  optionalString as asOptionalString,
} from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import {
  defineProviderExecutors,
  ProviderRequestError,
  providerUserAgent,
  requireApiKeyCredential,
} from "../provider-runtime.ts";

const defaultGitlabApiBaseUrl = "https://gitlab.com/api/v4";
const service = "gitlab";

export interface GitlabActionContext {
  apiKey: string;
  baseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

type GitlabRequestPhase = "validate" | "execute";
type GitlabActionInput = Record<string, unknown>;
type GitlabActionHandler = (input: GitlabActionInput, context: GitlabActionContext) => Promise<unknown>;

interface GitlabRequestOptions {
  method?: "GET" | "POST" | "PUT";
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

export const gitlabActionHandlers: Record<GitlabActionName, GitlabActionHandler> = {
  get_current_user(_input, context) {
    return gitlabRequestJson("/user", context);
  },
  list_projects(input, context) {
    return listGitlabCollection("projects", "/projects", context, {
      search: trimOptionalString(input.search),
      membership: optionalBoolean(input.membership),
      owned: optionalBoolean(input.owned),
      simple: optionalBoolean(input.simple),
      order_by: asOptionalString(input.orderBy),
      sort: asOptionalString(input.sort),
      page: asOptionalPositiveInteger(input.page, "page"),
      per_page: asOptionalPositiveInteger(input.perPage, "perPage"),
    });
  },
  get_project(input, context) {
    const projectId = readProjectId(input);
    return gitlabRequestJson(`/projects/${projectId}`, context);
  },
  list_project_issues(input, context) {
    return listGitlabCollection("issues", `/projects/${readProjectId(input)}/issues`, context, {
      state: asOptionalString(input.state),
      labels: trimOptionalString(input.labels),
      assignee_id: asOptionalPositiveInteger(input.assigneeId, "assigneeId"),
      search: trimOptionalString(input.search),
      order_by: asOptionalString(input.orderBy),
      sort: asOptionalString(input.sort),
      page: asOptionalPositiveInteger(input.page, "page"),
      per_page: asOptionalPositiveInteger(input.perPage, "perPage"),
    });
  },
  create_project_issue(input, context) {
    return createGitlabProjectIssue(input, context);
  },
  update_project_issue(input, context) {
    return updateGitlabProjectIssue(input, context);
  },
  create_issue_note(input, context) {
    return createGitlabIssueNote(input, context);
  },
  list_issue_notes(input, context) {
    return listGitlabCollection(
      "notes",
      `/projects/${readProjectId(input)}/issues/${readIssueIid(input)}/notes`,
      context,
      {
        sort: asOptionalString(input.sort),
        order_by: asOptionalString(input.orderBy),
        page: asOptionalPositiveInteger(input.page, "page"),
        per_page: asOptionalPositiveInteger(input.perPage, "perPage"),
      },
    );
  },
  list_commits(input, context) {
    return listGitlabCollection("commits", `/projects/${readProjectId(input)}/repository/commits`, context, {
      ref_name: trimOptionalString(input.refName),
      since: trimOptionalString(input.since),
      until: trimOptionalString(input.until),
      path: trimOptionalString(input.path),
      all: optionalBoolean(input.all),
      with_stats: optionalBoolean(input.withStats),
      page: asOptionalPositiveInteger(input.page, "page"),
      per_page: asOptionalPositiveInteger(input.perPage, "perPage"),
    });
  },
  get_commit(input, context) {
    const projectId = readProjectId(input);
    const commitSha = encodeURIComponent(readRequiredString(input.sha, "sha"));
    return gitlabRequestJson(`/projects/${projectId}/repository/commits/${commitSha}`, context);
  },
  list_branches(input, context) {
    return listGitlabCollection("branches", `/projects/${readProjectId(input)}/repository/branches`, context, {
      search: trimOptionalString(input.search),
      page: asOptionalPositiveInteger(input.page, "page"),
      per_page: asOptionalPositiveInteger(input.perPage, "perPage"),
    });
  },
  list_repository_tree(input, context) {
    return listGitlabCollection("tree", `/projects/${readProjectId(input)}/repository/tree`, context, {
      path: trimOptionalString(input.path),
      ref: trimOptionalString(input.ref),
      recursive: optionalBoolean(input.recursive),
      page: asOptionalPositiveInteger(input.page, "page"),
      per_page: asOptionalPositiveInteger(input.perPage, "perPage"),
    });
  },
  get_file(input, context) {
    return getGitlabFile(input, context);
  },
};

export const executors: ProviderExecutors = defineProviderExecutors<GitlabActionContext>({
  service,
  handlers: gitlabActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<GitlabActionContext> {
    const credential = await requireApiKeyCredential(context, service);
    return {
      apiKey: credential.apiKey,
      baseUrl: resolveGitlabBaseUrl({ values: credential.values, metadata: credential.metadata }),
      fetcher,
      signal: context.signal,
    };
  },
  fallbackMessage: "GitLab request failed.",
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher }) {
    const baseUrl = normalizeGitlabBaseUrl(input.values.baseUrl);
    const user = await gitlabRequestJson("/user", { apiKey: input.apiKey, baseUrl, fetcher }, "validate");
    const userObject = asGitlabObject(user);
    const userId = readOptionalPrimitive(userObject.id);
    const username = asOptionalString(userObject.username);
    const name = asOptionalString(userObject.name);

    return {
      profile: {
        accountId: userId ? `gitlab:${userId}` : (username ?? "gitlab:user"),
        displayName: name ?? username ?? "GitLab User",
      },
      metadata: compactObject({
        apiBaseUrl: baseUrl,
        validationEndpoint: "/user",
        userId,
        username,
        webUrl: asOptionalString(userObject.web_url),
      }),
    };
  },
};

function createGitlabProjectIssue(input: GitlabActionInput, context: GitlabActionContext): Promise<unknown> {
  const projectId = readProjectId(input);
  return gitlabRequestJson(`/projects/${projectId}/issues`, context, "execute", {
    method: "POST",
    body: compactObject({
      title: asOptionalString(input.title),
      description: asOptionalString(input.description),
      labels: trimOptionalString(input.labels),
      assignee_ids: Array.isArray(input.assigneeIds) ? input.assigneeIds : undefined,
      confidential: optionalBoolean(input.confidential),
      due_date: asOptionalString(input.dueDate),
    }),
  });
}

function updateGitlabProjectIssue(input: GitlabActionInput, context: GitlabActionContext): Promise<unknown> {
  const projectId = readProjectId(input);
  const issueIid = readIssueIid(input);
  return gitlabRequestJson(`/projects/${projectId}/issues/${issueIid}`, context, "execute", {
    method: "PUT",
    body: compactObject({
      title: asOptionalString(input.title),
      description: asOptionalString(input.description),
      labels: trimOptionalString(input.labels),
      add_labels: trimOptionalString(input.addLabels),
      remove_labels: trimOptionalString(input.removeLabels),
      state_event: asOptionalString(input.stateEvent),
      assignee_ids: Array.isArray(input.assigneeIds) ? input.assigneeIds : undefined,
      confidential: optionalBoolean(input.confidential),
      due_date: asOptionalString(input.dueDate),
    }),
  });
}

function createGitlabIssueNote(input: GitlabActionInput, context: GitlabActionContext): Promise<unknown> {
  const projectId = readProjectId(input);
  const issueIid = readIssueIid(input);
  const body = readRequiredString(input.body, "body");
  return gitlabRequestJson(`/projects/${projectId}/issues/${issueIid}/notes`, context, "execute", {
    method: "POST",
    body: { body },
  });
}

async function listGitlabCollection(
  key: string,
  path: string,
  context: GitlabActionContext,
  query: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await gitlabRequest(path, context, { query: compactObject(query) });
  const payload = await readGitlabPayload(response);
  if (!response.ok) {
    throw createGitlabError(response, payload, "execute");
  }
  if (!Array.isArray(payload)) {
    throw new ProviderRequestError(502, `gitlab ${key} response is not an array`, payload);
  }
  return { [key]: payload, ...readPagination(response.headers) };
}

async function getGitlabFile(input: GitlabActionInput, context: GitlabActionContext): Promise<unknown> {
  const projectId = readProjectId(input);
  const filePath = encodeURIComponent(readRequiredString(input.filePath, "filePath"));
  const ref = readRequiredString(input.ref, "ref");
  const payload = await gitlabRequestJson(`/projects/${projectId}/repository/files/${filePath}`, context, "execute", {
    query: { ref },
  });
  const file = asGitlabObject(payload);
  if (file.encoding === "base64" && typeof file.content === "string") {
    return { ...file, content_decoded: Buffer.from(file.content, "base64").toString("utf-8") };
  }
  return payload;
}

function readIssueIid(input: GitlabActionInput): number {
  const iid = optionalIntegerLike(input.issueIid, "issueIid", (message) => new ProviderRequestError(400, message));
  if (iid === undefined || iid < 1) {
    throw new ProviderRequestError(400, "issueIid is required and must be a positive integer");
  }
  return iid;
}

function readRequiredString(value: unknown, fieldName: string): string {
  const text = trimOptionalString(value);
  if (!text) {
    throw new ProviderRequestError(400, `${fieldName} is required`);
  }
  return text;
}

async function gitlabRequestJson(
  path: string,
  context: GitlabActionContext,
  phase: GitlabRequestPhase = "execute",
  options: GitlabRequestOptions = {},
): Promise<unknown> {
  const response = await gitlabRequest(path, context, options);
  const payload = await readGitlabPayload(response);
  if (!response.ok) {
    throw createGitlabError(response, payload, phase);
  }
  return payload;
}

async function gitlabRequest(
  path: string,
  context: GitlabActionContext,
  options: GitlabRequestOptions = {},
): Promise<Response> {
  const url = buildGitlabApiUrl(context.baseUrl, path, options.query ?? {});
  const headers = gitlabHeaders(context.apiKey, Boolean(options.body));

  try {
    return await context.fetcher(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `gitlab request failed: ${error.message}` : "gitlab request failed",
    );
  }
}

function gitlabHeaders(apiKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": providerUserAgent,
    "PRIVATE-TOKEN": apiKey,
  };
  if (hasBody) {
    headers["content-type"] = "application/json";
  }
  return headers;
}

async function readGitlabPayload(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function createGitlabError(response: Response, payload: unknown, phase: GitlabRequestPhase): ProviderRequestError {
  const message = extractGitlabErrorMessage(payload) ?? response.statusText ?? "gitlab request failed";
  if (response.status === 401 || response.status === 403) {
    return new ProviderRequestError(
      phase === "validate" ? 400 : response.status,
      `gitlab authentication failed: ${message}`,
      payload,
    );
  }

  if (response.status === 400 || response.status === 404 || response.status === 422) {
    return new ProviderRequestError(response.status, `gitlab request failed: ${message}`, payload);
  }

  return new ProviderRequestError(response.status || 502, `gitlab request failed: ${message}`, payload);
}

function extractGitlabErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const message = record.message ?? record.error ?? record.error_description;
  if (typeof message === "string") {
    return message;
  }
  if (Array.isArray(message)) {
    return message.map(String).join(", ");
  }
  if (message && typeof message === "object") {
    return Object.entries(message as Record<string, unknown>)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
      .join("; ");
  }
  return undefined;
}

function readProjectId(input: GitlabActionInput): string {
  return readRequiredString(input.projectId, "projectId");
}

function trimOptionalString(value: unknown): string | undefined {
  const text = asOptionalString(value)?.trim();
  return text || undefined;
}

function readOptionalPrimitive(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function asGitlabObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readPagination(headers: Headers): {
  total: number | null;
  nextPage: number | null;
} {
  return {
    total: readOptionalHeaderInteger(headers, "x-total"),
    nextPage: readOptionalHeaderInteger(headers, "x-next-page"),
  };
}

export function normalizeGitlabBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return defaultGitlabApiBaseUrl;
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
  if (pathname.endsWith("/api/v4")) {
    pathname = pathname.slice(0, -"/api/v4".length);
  }

  const base = pathname === "/" || pathname === "" ? parsed.origin : `${parsed.origin}${pathname}`;
  return `${base}/api/v4`;
}

export function buildGitlabApiUrl(apiBaseUrl: string, path: string, query: Record<string, unknown> = {}): string {
  const url = new URL(`${apiBaseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function resolveGitlabBaseUrl(input: {
  values: Record<string, string>;
  metadata: Record<string, unknown>;
}): string {
  const raw = asOptionalString(input.metadata.apiBaseUrl) ?? asOptionalString(input.values.baseUrl);
  return normalizeGitlabBaseUrl(raw);
}

function readOptionalHeaderInteger(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function asOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  const parsed = optionalIntegerLike(value, fieldName, (message) => new ProviderRequestError(400, message));
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed < 1) {
    throw new ProviderRequestError(400, `${fieldName} must be a positive integer`);
  }
  return parsed;
}

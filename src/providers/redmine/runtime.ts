import type { CredentialValidationResult } from "../../core/types.ts";
import type { RedmineActionName } from "./actions.ts";

import {
  compactObject,
  optionalBoolean,
  optionalInteger,
  optionalIntegerLike,
  optionalRecord,
  optionalString,
  positiveInteger,
  requiredString,
} from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import { providerUserAgent, ProviderRequestError } from "../provider-runtime.ts";

const redmineValidationPath = "/users/current.json";
const maxListLimit = 100;

type RedmineRequestPhase = "validate" | "execute";
type RedmineQueryValue = string | number | boolean | undefined;

export interface RedmineActionContext {
  apiKey: string;
  baseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

type RedmineActionHandler = (input: Record<string, unknown>, context: RedmineActionContext) => Promise<unknown>;

export const redmineActionHandlers: Record<RedmineActionName, RedmineActionHandler> = {
  get_current_user(_input, context) {
    return getCurrentUser(context);
  },
  list_issues(input, context) {
    return listIssues(input, context);
  },
  get_issue(input, context) {
    return getIssue(input, context);
  },
  create_issue(input, context) {
    return createIssue(input, context);
  },
  update_issue(input, context) {
    return updateIssue(input, context);
  },
  list_projects(input, context) {
    return listProjects(input, context);
  },
  get_project(input, context) {
    return getProject(input, context);
  },
  create_time_entry(input, context) {
    return createTimeEntry(input, context);
  },
  list_time_entries(input, context) {
    return listTimeEntries(input, context);
  },
  search(input, context) {
    return search(input, context);
  },
  list_trackers(_input, context) {
    return listEnumeration(context, "/trackers.json", "trackers");
  },
  list_issue_statuses(_input, context) {
    return listEnumeration(context, "/issue_statuses.json", "issue_statuses");
  },
  list_issue_priorities(_input, context) {
    return listEnumeration(context, "/enumerations/issue_priorities.json", "issue_priorities");
  },
  list_time_entry_activities(_input, context) {
    return listEnumeration(context, "/enumerations/time_entry_activities.json", "time_entry_activities");
  },
};

export async function validateRedmineCredential(
  input: { apiKey: string; values: Record<string, string> },
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const baseUrl = normalizeRedmineBaseUrl(input.values.baseUrl);
  const { payload } = await requestRedmineJson<Record<string, unknown>>({
    apiKey: input.apiKey,
    baseUrl,
    path: redmineValidationPath,
    fetcher,
    signal,
    phase: "validate",
  });

  const user = optionalRecord(unwrapRecord(payload, "user")) ?? {};
  const id = normalizeUnknownString(user.id);
  const login = optionalString(user.login);
  if (!id && !login) {
    throw new ProviderRequestError(502, "redmine current user response is missing id");
  }

  return {
    profile: {
      accountId: buildRedmineAccountId(baseUrl, user),
      displayName: buildRedmineAccountLabel(user),
    },
    grantedScopes: [],
    metadata: compactObject({
      baseUrl,
      validationEndpoint: redmineValidationPath,
      userId: id,
      login,
      email: optionalString(user.mail),
    }),
  };
}

async function getCurrentUser(context: RedmineActionContext): Promise<unknown> {
  const { payload } = await requestRedmineJson<Record<string, unknown>>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path: redmineValidationPath,
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
  });
  return unwrapRecord(payload, "user");
}

async function listIssues(input: Record<string, unknown>, context: RedmineActionContext): Promise<unknown> {
  const { payload } = await requestRedmineJson<Record<string, unknown>>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path: "/issues.json",
    query: compactObject({
      project_id: optionalString(input.projectId),
      subproject_id: optionalString(input.subprojectId),
      tracker_id: readOptionalPositiveInteger(input.trackerId, "trackerId"),
      status_id: optionalString(input.statusId),
      priority_id: readOptionalPositiveInteger(input.priorityId, "priorityId"),
      assigned_to_id: optionalString(input.assignedToId),
      author_id: optionalString(input.authorId),
      parent_id: readOptionalPositiveInteger(input.parentId, "parentId"),
      created_on: optionalString(input.createdOn),
      updated_on: optionalString(input.updatedOn),
      sort: optionalString(input.sort),
      include: joinCsvStrings(input.include, "include"),
      limit: readOptionalLimit(input.limit),
      offset: readOptionalNonNegativeInteger(input.offset, "offset"),
    }),
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
  });

  return normalizeListEnvelope(payload, "issues");
}

async function getIssue(input: Record<string, unknown>, context: RedmineActionContext): Promise<unknown> {
  const id = requirePositiveInteger(input.id, "id");
  const { payload } = await requestRedmineJson<Record<string, unknown>>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path: `/issues/${id}.json`,
    query: compactObject({
      include: joinCsvStrings(input.include, "include") ?? "journals,attachments,relations",
    }),
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
    notFoundAsInvalidInput: true,
  });
  return unwrapRecord(payload, "issue");
}

async function createIssue(input: Record<string, unknown>, context: RedmineActionContext): Promise<unknown> {
  const issue = compactObject({
    project_id: requireIdLike(input.projectId, "projectId"),
    subject: requireInputString(input.subject, "subject"),
    description: optionalString(input.description),
    tracker_id: readOptionalPositiveInteger(input.trackerId, "trackerId"),
    status_id: readOptionalPositiveInteger(input.statusId, "statusId"),
    priority_id: readOptionalPositiveInteger(input.priorityId, "priorityId"),
    assigned_to_id: readOptionalPositiveInteger(input.assignedToId, "assignedToId"),
    category_id: readOptionalPositiveInteger(input.categoryId, "categoryId"),
    fixed_version_id: readOptionalPositiveInteger(input.fixedVersionId, "fixedVersionId"),
    parent_issue_id: readOptionalPositiveInteger(input.parentIssueId, "parentIssueId"),
    start_date: optionalString(input.startDate),
    due_date: optionalString(input.dueDate),
    estimated_hours: readOptionalNumber(input.estimatedHours, "estimatedHours"),
    done_ratio: readOptionalNonNegativeInteger(input.doneRatio, "doneRatio"),
    is_private: optionalBoolean(input.isPrivate),
    watcher_user_ids: normalizeOptionalPositiveIntegerArray(input.watcherUserIds, "watcherUserIds"),
  });

  const { payload } = await requestRedmineJson<Record<string, unknown>>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path: "/issues.json",
    method: "POST",
    body: { issue },
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
    notFoundAsInvalidInput: true,
  });
  return unwrapRecord(payload, "issue");
}

async function updateIssue(input: Record<string, unknown>, context: RedmineActionContext): Promise<unknown> {
  const id = requirePositiveInteger(input.id, "id");
  const issue = compactObject({
    subject: optionalString(input.subject),
    description: optionalString(input.description),
    tracker_id: readOptionalPositiveInteger(input.trackerId, "trackerId"),
    status_id: readOptionalPositiveInteger(input.statusId, "statusId"),
    priority_id: readOptionalPositiveInteger(input.priorityId, "priorityId"),
    assigned_to_id: readOptionalPositiveInteger(input.assignedToId, "assignedToId"),
    category_id: readOptionalPositiveInteger(input.categoryId, "categoryId"),
    fixed_version_id: readOptionalPositiveInteger(input.fixedVersionId, "fixedVersionId"),
    parent_issue_id: readOptionalPositiveInteger(input.parentIssueId, "parentIssueId"),
    start_date: optionalString(input.startDate),
    due_date: optionalString(input.dueDate),
    estimated_hours: readOptionalNumber(input.estimatedHours, "estimatedHours"),
    done_ratio: readOptionalNonNegativeInteger(input.doneRatio, "doneRatio"),
    is_private: optionalBoolean(input.isPrivate),
    notes: optionalString(input.notes),
    private_notes: optionalBoolean(input.privateNotes),
  });

  if (Object.keys(issue).length === 0) {
    throw new ProviderRequestError(400, "update_issue requires at least one field to change");
  }

  await requestRedmineJson<unknown>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path: `/issues/${id}.json`,
    method: "PUT",
    body: { issue },
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
    notFoundAsInvalidInput: true,
  });
  return { ok: true, id };
}

async function listProjects(input: Record<string, unknown>, context: RedmineActionContext): Promise<unknown> {
  const { payload } = await requestRedmineJson<Record<string, unknown>>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path: "/projects.json",
    query: compactObject({
      include: joinCsvStrings(input.include, "include"),
      limit: readOptionalLimit(input.limit),
      offset: readOptionalNonNegativeInteger(input.offset, "offset"),
    }),
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
  });
  return normalizeListEnvelope(payload, "projects");
}

async function getProject(input: Record<string, unknown>, context: RedmineActionContext): Promise<unknown> {
  const id = requireIdLike(input.id, "id");
  const { payload } = await requestRedmineJson<Record<string, unknown>>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path: `/projects/${encodeURIComponent(String(id))}.json`,
    query: compactObject({
      include: joinCsvStrings(input.include, "include"),
    }),
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
    notFoundAsInvalidInput: true,
  });
  return unwrapRecord(payload, "project");
}

async function createTimeEntry(input: Record<string, unknown>, context: RedmineActionContext): Promise<unknown> {
  const issueId = readOptionalPositiveInteger(input.issueId, "issueId");
  const projectId = input.projectId == null ? undefined : requireIdLike(input.projectId, "projectId");
  if (issueId === undefined && projectId === undefined) {
    throw new ProviderRequestError(400, "create_time_entry requires issueId or projectId");
  }

  const timeEntry = compactObject({
    issue_id: issueId,
    project_id: projectId,
    hours: requireNumber(input.hours, "hours"),
    activity_id: requirePositiveInteger(input.activityId, "activityId"),
    spent_on: optionalString(input.spentOn),
    comments: optionalString(input.comments),
    user_id: readOptionalPositiveInteger(input.userId, "userId"),
  });

  const { payload } = await requestRedmineJson<Record<string, unknown>>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path: "/time_entries.json",
    method: "POST",
    body: { time_entry: timeEntry },
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
    notFoundAsInvalidInput: true,
  });
  return unwrapRecord(payload, "time_entry");
}

async function listTimeEntries(input: Record<string, unknown>, context: RedmineActionContext): Promise<unknown> {
  const { payload } = await requestRedmineJson<Record<string, unknown>>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path: "/time_entries.json",
    query: compactObject({
      user_id: optionalString(input.userId),
      project_id: optionalString(input.projectId),
      issue_id: readOptionalPositiveInteger(input.issueId, "issueId"),
      spent_on: optionalString(input.spentOn),
      from: optionalString(input.from),
      to: optionalString(input.to),
      limit: readOptionalLimit(input.limit),
      offset: readOptionalNonNegativeInteger(input.offset, "offset"),
    }),
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
  });
  return normalizeListEnvelope(payload, "time_entries");
}

async function search(input: Record<string, unknown>, context: RedmineActionContext): Promise<unknown> {
  const { payload } = await requestRedmineJson<Record<string, unknown>>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path: "/search.json",
    query: compactObject({
      q: requireInputString(input.query, "query"),
      scope: optionalString(input.scope),
      all_words: searchFlag(input.allWords),
      titles_only: searchFlag(input.titlesOnly),
      open_issues: searchFlag(input.openIssues),
      issues: searchFlag(input.issues),
      news: searchFlag(input.news),
      documents: searchFlag(input.documents),
      changesets: searchFlag(input.changesets),
      wiki_pages: searchFlag(input.wikiPages),
      messages: searchFlag(input.messages),
      projects: searchFlag(input.projects),
      limit: readOptionalLimit(input.limit),
      offset: readOptionalNonNegativeInteger(input.offset, "offset"),
    }),
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
  });
  return normalizeListEnvelope(payload, "results");
}

async function listEnumeration(context: RedmineActionContext, path: string, key: string): Promise<unknown> {
  const { payload } = await requestRedmineJson<Record<string, unknown>>({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    path,
    fetcher: context.fetcher,
    signal: context.signal,
    phase: "execute",
  });
  return normalizeListEnvelope(payload, key);
}

interface RedmineRequestInput {
  apiKey: string;
  baseUrl: string;
  path: string;
  fetcher: typeof fetch;
  phase: RedmineRequestPhase;
  signal?: AbortSignal;
  method?: string;
  query?: Record<string, RedmineQueryValue>;
  body?: Record<string, unknown>;
  notFoundAsInvalidInput?: boolean;
}

async function requestRedmineJson<T>(input: RedmineRequestInput): Promise<{ payload: T }> {
  const response = await redmineFetch(input);
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw toRedmineError(response, payload, input.phase, input.notFoundAsInvalidInput);
  }
  return { payload: payload as T };
}

async function redmineFetch(input: RedmineRequestInput): Promise<Response> {
  const headers = new Headers({
    Accept: "application/json",
    "X-Redmine-API-Key": input.apiKey,
    "User-Agent": providerUserAgent,
  });

  let body: string | undefined;
  if (input.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(input.body);
  }

  return input.fetcher(buildRedmineApiUrl(input.baseUrl, input.path, input.query), {
    method: input.method ?? "GET",
    headers,
    body,
    signal: input.signal,
  });
}

/**
 * Build an absolute Redmine API URL by concatenating the normalized base URL
 * with the endpoint path. The base URL keeps any instance sub-path such as
 * `/redmine`, so the path is appended rather than resolved against the origin.
 */
export function buildRedmineApiUrl(baseUrl: string, path: string, query?: Record<string, RedmineQueryValue>): string {
  const url = new URL(`${baseUrl}${ensureLeadingSlash(path)}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Normalize a user-configured Redmine base URL. Unlike single-path API
 * providers, Redmine endpoints live directly under the configured instance
 * root, so any sub-path (for example `/redmine`) MUST be preserved.
 */
export function normalizeRedmineBaseUrl(value: string | undefined): string {
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

export function resolveRedmineBaseUrl(input: {
  values: Record<string, string>;
  metadata: Record<string, unknown>;
}): string {
  const baseUrl = optionalString(input.metadata.baseUrl) ?? optionalString(input.values.baseUrl);
  if (!baseUrl) {
    throw new ProviderRequestError(500, "redmine provider metadata is missing baseUrl");
  }
  return normalizeRedmineBaseUrl(baseUrl);
}

function buildRedmineAccountId(baseUrl: string, user: Record<string, unknown>): string {
  const instanceKey = buildInstanceKey(baseUrl);
  const id = normalizeUnknownString(user.id);
  if (id) {
    return `redmine:${instanceKey}:${id}`;
  }

  const login = optionalString(user.login);
  if (login) {
    return `redmine:${instanceKey}:${login}`;
  }

  throw new ProviderRequestError(502, "redmine current user response is missing id");
}

function buildRedmineAccountLabel(user: Record<string, unknown>): string {
  const fullName = [optionalString(user.firstname), optionalString(user.lastname)].filter(Boolean).join(" ");
  return (
    (fullName || undefined) ??
    optionalString(user.login) ??
    optionalString(user.mail) ??
    normalizeUnknownString(user.id) ??
    "Redmine User"
  );
}

function buildInstanceKey(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.host}${pathname}`;
}

function unwrapRecord(payload: unknown, key: string): unknown {
  const record = optionalRecord(payload);
  if (record && record[key] !== undefined) {
    return record[key];
  }
  return payload;
}

function normalizeListEnvelope(payload: unknown, key: string): Record<string, unknown> {
  const record = optionalRecord(payload) ?? {};
  return compactObject({
    [key]: normalizeArray(record[key], `redmine ${key} list`),
    total_count: optionalInteger(record.total_count),
    offset: optionalInteger(record.offset),
    limit: optionalInteger(record.limit),
  });
}

function requireInputString(value: unknown, fieldName: string): string {
  return requiredString(value, fieldName, (message) => new ProviderRequestError(400, message));
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  return positiveInteger(value, fieldName, (message) => new ProviderRequestError(400, message));
}

function readOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  const parsed = optionalIntegerLike(value, fieldName, (message) => new ProviderRequestError(400, message));
  if (parsed !== undefined && parsed <= 0) {
    throw new ProviderRequestError(400, `${fieldName} must be a positive integer`);
  }
  return parsed;
}

function readOptionalNonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  const parsed = optionalIntegerLike(value, fieldName, (message) => new ProviderRequestError(400, message));
  if (parsed !== undefined && parsed < 0) {
    throw new ProviderRequestError(400, `${fieldName} must be zero or a positive integer`);
  }
  return parsed;
}

function readOptionalLimit(value: unknown): number | undefined {
  const parsed = readOptionalPositiveInteger(value, "limit");
  if (parsed !== undefined && parsed > maxListLimit) {
    throw new ProviderRequestError(400, `limit must be between 1 and ${maxListLimit}`);
  }
  return parsed;
}

function requireNumber(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new ProviderRequestError(400, `${fieldName} must be a number`);
}

function readOptionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return requireNumber(value, fieldName);
}

function requireIdLike(value: unknown, fieldName: string): string | number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  const text = optionalString(value);
  if (text) {
    return text;
  }
  throw new ProviderRequestError(400, `${fieldName} is required`);
}

function normalizeOptionalPositiveIntegerArray(value: unknown, fieldName: string): number[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ProviderRequestError(400, `${fieldName} must be an array`);
  }
  return value.map((item) => requirePositiveInteger(item, fieldName));
}

function joinCsvStrings(value: unknown, fieldName: string): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return optionalString(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => requireInputString(item, fieldName));
    return parts.length > 0 ? parts.join(",") : undefined;
  }
  throw new ProviderRequestError(400, `${fieldName} must be a string or array of strings`);
}

function searchFlag(value: unknown): string | undefined {
  return optionalBoolean(value) === true ? "1" : undefined;
}

function normalizeArray(value: unknown, fieldName: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new ProviderRequestError(502, `${fieldName} must be an array`);
  }
  return value.map((item) => optionalRecord(item) ?? {});
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

function toRedmineError(
  response: Response,
  payload: unknown,
  phase: RedmineRequestPhase,
  notFoundAsInvalidInput = false,
): ProviderRequestError {
  const message = extractRedmineMessage(payload) ?? `redmine request failed with ${response.status}`;

  if (response.status === 429) {
    return new ProviderRequestError(429, message, payload);
  }
  if (response.status === 401) {
    return new ProviderRequestError(phase === "validate" ? 400 : 401, message, payload);
  }
  if (response.status === 403) {
    return new ProviderRequestError(phase === "validate" ? 400 : 403, message, payload);
  }
  if (response.status === 404 && notFoundAsInvalidInput) {
    return new ProviderRequestError(400, message, payload);
  }
  if ([400, 404, 409, 422].includes(response.status)) {
    return new ProviderRequestError(response.status === 404 ? 404 : 400, message, payload);
  }

  return new ProviderRequestError(response.status || 502, message, payload);
}

function extractRedmineMessage(payload: unknown): string | undefined {
  const record = optionalRecord(payload);
  if (!record) {
    return undefined;
  }

  const errors = record.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("; ");
  }

  return optionalString(record.message) ?? optionalString(record.error);
}

function normalizeUnknownString(value: unknown): string | undefined {
  if (typeof value === "string" && value) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

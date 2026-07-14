# GitLab Self-Hosted Provider + Issue Workflow Actions

**Date:** 2026-07-14
**Repo:** `oomol-open-connector` (fork), new branch off `add-redmine-provider`
**Status:** Design — awaiting approval

## Problem

The built-in GitLab provider (`src/providers/gitlab/`) hardcodes the API base
URL to gitlab.com:

```ts
// src/providers/gitlab/executors.ts:13
const gitlabApiBaseUrl = "https://gitlab.com/api/v4";
```

Every request and the credential validator use this constant, so the provider
can only talk to gitlab.com. It cannot reach a company self-hosted GitLab
instance (e.g. `https://gl.thread.tw`).

Separately, the provider exposes only 5 read/create actions. There is no way to
update an issue or add a comment (note), which the issue-tracking workflow needs.

## Goal

1. Make the GitLab provider work against a **per-connection** base URL so the
   same provider serves both gitlab.com and self-hosted instances.
2. Add three issue-workflow actions: update an issue, create an issue note,
   list issue notes.

Backward compatibility: existing gitlab.com connections keep working with no
base URL entered (empty → gitlab.com default).

## Design

This mirrors the Redmine provider added earlier (`src/providers/redmine/`),
which already solved the self-hosted base-URL problem. We reuse the same
mechanism rather than inventing a new one.

### 1. `definition.ts` — add an optional `baseUrl` extra field

Add to the `api_key` auth entry:

```ts
extraFields: [
  {
    key: "baseUrl",
    label: "Base URL",
    inputType: "text",
    required: false,          // optional → empty defaults to gitlab.com
    secret: false,
    placeholder: "https://gitlab.com",
    description:
      "Your GitLab instance base URL, e.g. https://gitlab.example.com. " +
      "Leave blank to use gitlab.com. Must be https.",
  },
],
```

Optional (not required, unlike Redmine) is deliberate: it preserves existing
gitlab.com connections that were created without this field.

### 2. `executors.ts` — resolve base URL from the connection

- Replace `defineApiKeyProviderExecutors(service, handlers)` with
  `defineProviderExecutors<GitlabActionContext>({ service, handlers,
  createContext, fallbackMessage })`, matching Redmine's `executors.ts`.
- `GitlabActionContext` gains `baseUrl: string`.
- `createContext` calls `requireApiKeyCredential(context, service)` then
  resolves the base URL from `credential.values.baseUrl` / `credential.metadata`.
- `gitlabRequest` uses `context.baseUrl` instead of the deleted constant.
- `credentialValidators.apiKey` reads `input.values.baseUrl`, validates against
  the resolved instance's `/user`, and stores the resolved `apiBaseUrl` in
  metadata.

New helper `normalizeGitlabBaseUrl(value: string | undefined): string`,
modeled on `normalizeRedmineBaseUrl`:

- Empty/whitespace → return `"https://gitlab.com/api/v4"` (the default).
- Otherwise run the raw value through `assertPublicHttpUrl` (reused from
  `src/core/request.ts`): enforces **https**, rejects private/reserved IPs and
  localhost, strips query/hash.
- Strip a trailing `/` and a trailing `/api/v4` if the user typed one, so we
  do not double it. Preserve any sub-path (e.g. `https://example.com/gitlab`).
- Return `${origin}${subpath}/api/v4`.

`resolveGitlabBaseUrl({ values, metadata })` prefers `metadata.baseUrl`, falls
back to `values.baseUrl`, then to the gitlab.com default — matching Redmine's
`resolveRedmineBaseUrl` (except the default, since Redmine has no default host).

### 3. `actions.ts` — three new actions

Reuse the existing `s`-schema style and `projectId` field. Add a shared
`issueIid` input field and a `note` output schema.

- **`update_project_issue`** → `PUT /projects/:id/issues/:issue_iid`
  Input: `projectId`, `issueIid` (required), plus optional `title`,
  `description`, `labels`, `addLabels`, `removeLabels`,
  `stateEvent` (`close` | `reopen`), `assigneeIds`, `confidential`, `dueDate`.
  Output: `issue` (existing schema).

- **`create_issue_note`** → `POST /projects/:id/issues/:issue_iid/notes`
  Input: `projectId`, `issueIid`, `body` (all required).
  Output: `note`.

- **`list_issue_notes`** → `GET /projects/:id/issues/:issue_iid/notes`
  Input: `projectId`, `issueIid` (required), optional `sort` (`asc`|`desc`),
  `orderBy` (`created_at`|`updated_at`), pagination.
  Output: paginated notes (`{ notes, total, nextPage }`), same pagination
  shape as `paginatedIssues`.

`note` output schema (looseObject): `id`, `body`, `author` (reuse `user`),
`created_at`, `updated_at`, `system` (bool), `noteable_iid`.

### 4. Regenerate + rebuild + smoke test

- `npm run generate:registry` (updates `registry.generated.ts`), then
  `npm run typecheck`.
- Rebuild the custom image and restart the container (existing runbook recipe
  in the `kd-openconnector` deployment repo).
- Smoke test: create a real `gitlab` connection with a PAT + baseUrl
  `https://gl.thread.tw`, run `get_current_user`, `list_projects`,
  `create_issue_note`, and `list_issue_notes` against a real project.

## Testing (TDD)

Add `src/providers/gitlab/runtime.test.ts` (mirrors
`redmine/runtime.test.ts`), written before the implementation:

- `normalizeGitlabBaseUrl`: empty → gitlab.com default; `https://gl.thread.tw`
  → `https://gl.thread.tw/api/v4`; trailing slash trimmed; sub-path preserved;
  `http://` rejected; private IP rejected; trailing `/api/v4` not doubled.
- `createContext` / request builder: hits `context.baseUrl`, sends the
  `PRIVATE-TOKEN` header.
- `update_project_issue` / `create_issue_note` / `list_issue_notes`: correct
  method, path, and body against a fetch stub; pagination parsed from
  `x-total` / `x-next-page` headers for `list_issue_notes`.

## Constraints & assumptions

- **https only.** `assertPublicHttpUrl` enforces https and rejects private/
  reserved IPs. Assumes `gl.thread.tw` serves the API over https on a public
  DNS name (the `:12022` seen previously is the git/SSH port, not the web API).
  If the instance is only reachable over http or a private address, that is a
  separate infra concern surfaced by this constraint, not solved here.
- Auth is unchanged: GitLab self-hosted uses the same Personal Access Token +
  `PRIVATE-TOKEN` header as gitlab.com.
- No OAuth. Scope stays api_key-only, consistent with the current provider.

## Out of scope

- Merge Requests, pipelines, commits, and other non-issue surfaces.
- Group-level (vs project-level) issue listing.
- Editing/deleting existing notes.

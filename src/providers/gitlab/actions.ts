import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "gitlab";

export type GitlabActionName = (typeof gitlabActions)[number]["name"];

interface GitlabActionSource {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

const pagination = {
  page: s.integer({ minimum: 1, description: "The page number to fetch." }),
  perPage: s.integer({ minimum: 1, maximum: 100, description: "The number of results per page." }),
};

function paginated(key: string, item: JsonSchema, plural: string, responsePlural: string = plural): JsonSchema {
  const capitalized = plural.charAt(0).toUpperCase() + plural.slice(1);
  return s.object(
    {
      [key]: s.array(item, { description: `${capitalized} returned by GitLab.` }),
      total: s.nullable(s.integer({ description: `The total number of ${plural} when GitLab returns it.` })),
      nextPage: s.nullable(s.integer({ description: "The next page number when another page exists." })),
    },
    { required: [key, "total", "nextPage"], description: `A paginated GitLab ${responsePlural} response.` },
  );
}
const user = s.looseObject(
  {
    id: s.integer({ description: "The GitLab user ID." }),
    username: s.string({ description: "The GitLab username." }),
    name: s.string({ description: "The display name." }),
    state: s.string({ description: "The user state." }),
    avatar_url: s.nullableString("The avatar URL."),
    web_url: s.string({ description: "The GitLab profile URL." }),
    email: s.string({ description: "The email address when visible." }),
    public_email: s.string({ description: "The public email address when visible." }),
  },
  { description: "A GitLab user record." },
);
const namespace = s.looseObject(
  {
    id: s.integer({ description: "The namespace ID." }),
    name: s.string({ description: "The namespace name." }),
    path: s.string({ description: "The namespace path." }),
    kind: s.string({ description: "The namespace kind." }),
    full_path: s.string({ description: "The full namespace path." }),
  },
  { description: "A GitLab namespace record." },
);
const project = s.looseObject(
  {
    id: s.integer({ description: "The project ID." }),
    name: s.string({ description: "The project name." }),
    path: s.string({ description: "The project path." }),
    path_with_namespace: s.string({ description: "The project path including namespace." }),
    description: s.nullableString("The project description."),
    default_branch: s.nullableString("The default branch name."),
    visibility: s.string({ description: "The project visibility." }),
    web_url: s.string({ description: "The project URL." }),
    ssh_url_to_repo: s.string({ description: "The SSH clone URL." }),
    http_url_to_repo: s.string({ description: "The HTTPS clone URL." }),
    readme_url: s.nullableString("The README URL when returned by GitLab."),
    created_at: s.string({ description: "The project creation timestamp." }),
    last_activity_at: s.string({ description: "The last activity timestamp." }),
    archived: s.boolean({ description: "Whether the project is archived." }),
    star_count: s.integer({ description: "The number of stars." }),
    forks_count: s.integer({ description: "The number of forks." }),
    open_issues_count: s.integer({ description: "The number of open issues." }),
    namespace,
  },
  { description: "A GitLab project record." },
);
const milestone = s.looseObject(
  {
    id: s.integer({ description: "The milestone ID." }),
    iid: s.integer({ description: "The internal milestone ID within the project." }),
    title: s.string({ description: "The milestone title." }),
    description: s.nullableString("The milestone description."),
    state: s.string({ description: "The milestone state." }),
    due_date: s.nullableString("The milestone due date."),
    start_date: s.nullableString("The milestone start date."),
    web_url: s.string({ description: "The milestone URL." }),
  },
  { description: "A GitLab milestone record." },
);
const issue = s.looseObject(
  {
    id: s.integer({ description: "The issue ID." }),
    iid: s.integer({ description: "The internal issue ID within the project." }),
    project_id: s.integer({ description: "The project ID." }),
    title: s.string({ description: "The issue title." }),
    description: s.nullableString("The issue description."),
    state: s.string({ description: "The issue state." }),
    web_url: s.string({ description: "The issue URL." }),
    confidential: s.boolean({ description: "Whether the issue is confidential." }),
    discussion_locked: s.nullable(s.boolean({ description: "Whether discussions are locked." })),
    issue_type: s.string({ description: "The GitLab issue type." }),
    author: user,
    assignees: s.array(user, { description: "Users assigned to the issue." }),
    labels: s.array(s.string({ description: "A label name." }), { description: "Labels attached to the issue." }),
    milestone: s.nullable(milestone),
    created_at: s.string({ description: "The issue creation timestamp." }),
    updated_at: s.string({ description: "The issue update timestamp." }),
    closed_at: s.nullableString("The timestamp when the issue was closed."),
    due_date: s.nullableString("The issue due date."),
    user_notes_count: s.integer({ description: "The number of notes on the issue." }),
  },
  { description: "A GitLab issue record." },
);
const paginatedProjects = paginated("projects", project, "projects");
const paginatedIssues = paginated("issues", issue, "issues");
const note = s.looseObject(
  {
    id: s.integer({ description: "The note ID." }),
    body: s.string({ description: "The note body." }),
    author: user,
    created_at: s.string({ description: "The note creation timestamp." }),
    updated_at: s.string({ description: "The note update timestamp." }),
    system: s.boolean({ description: "Whether the note was generated by GitLab rather than a user." }),
    noteable_iid: s.integer({ description: "The iid of the issue the note belongs to." }),
  },
  { description: "A GitLab issue note record." },
);
const paginatedNotes = paginated("notes", note, "notes", "issue notes");
const commit = s.looseObject(
  {
    id: s.string({ description: "The full commit SHA." }),
    short_id: s.string({ description: "The abbreviated commit SHA." }),
    title: s.string({ description: "The commit title (first line of the message)." }),
    message: s.string({ description: "The full commit message." }),
    author_name: s.string({ description: "The commit author name." }),
    author_email: s.string({ description: "The commit author email." }),
    authored_date: s.string({ description: "The authoring timestamp." }),
    committer_name: s.string({ description: "The committer name." }),
    committed_date: s.string({ description: "The commit timestamp." }),
    web_url: s.string({ description: "The commit URL." }),
    parent_ids: s.array(s.string({ description: "A parent commit SHA." }), { description: "Parent commit SHAs." }),
  },
  { description: "A GitLab commit record." },
);
const branch = s.looseObject(
  {
    name: s.string({ description: "The branch name." }),
    merged: s.boolean({ description: "Whether the branch is merged into the default branch." }),
    protected: s.boolean({ description: "Whether the branch is protected." }),
    default: s.boolean({ description: "Whether this is the default branch." }),
    web_url: s.string({ description: "The branch URL." }),
    commit,
  },
  { description: "A GitLab branch record." },
);
const paginatedCommits = paginated("commits", commit, "commits");
const paginatedBranches = paginated("branches", branch, "branches");
const projectId = s.string({
  minLength: 1,
  description: "The GitLab project ID or URL-encoded path with namespace, such as 123 or group%2Fproject.",
});
const sha = s.string({ minLength: 1, description: "The commit hash (SHA) or a branch/tag name that resolves to one." });
const issueIid = s.integer({ minimum: 1, description: "The internal issue ID (iid) within the project." });

function input(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return s.actionInput(properties, required, "GitLab action input.");
}

const actions: GitlabActionSource[] = [
  {
    name: "get_current_user",
    description: "Get the current authenticated GitLab user profile.",
    inputSchema: input({}),
    outputSchema: user,
  },
  {
    name: "list_projects",
    description:
      "List GitLab projects visible to the authenticated personal access token, with optional search and membership filters.",
    inputSchema: input({
      search: s.string({ minLength: 1, description: "Search projects by name or path." }),
      membership: s.boolean({ description: "Limit results to projects the authenticated user is a member of." }),
      owned: s.boolean({ description: "Limit results to projects explicitly owned by the authenticated user." }),
      simple: s.boolean({ description: "Return a simplified project representation from GitLab." }),
      orderBy: s.stringEnum(["id", "name", "path", "created_at", "updated_at", "last_activity_at"], {
        description: "Sort projects by a GitLab-supported field.",
      }),
      sort: s.stringEnum(["asc", "desc"], { description: "Sort direction." }),
      ...pagination,
    }),
    outputSchema: paginatedProjects,
  },
  {
    name: "get_project",
    description: "Get a GitLab project by numeric ID or URL-encoded path with namespace.",
    inputSchema: input({ projectId }, ["projectId"]),
    outputSchema: project,
  },
  {
    name: "list_project_issues",
    description: "List issues for a GitLab project with common state, label, assignee, and search filters.",
    inputSchema: input(
      {
        projectId,
        state: s.stringEnum(["opened", "closed", "all"], { description: "Issue state filter." }),
        labels: s.string({ minLength: 1, description: "Comma-separated label names to filter issues by." }),
        assigneeId: s.integer({ description: "Filter by assignee user ID." }),
        search: s.string({ minLength: 1, description: "Search issues by title or description." }),
        orderBy: s.stringEnum(
          [
            "created_at",
            "updated_at",
            "priority",
            "due_date",
            "relative_position",
            "label_priority",
            "milestone_due",
            "popularity",
            "weight",
          ],
          { description: "Sort issues by a GitLab-supported field." },
        ),
        sort: s.stringEnum(["asc", "desc"], { description: "Sort direction." }),
        ...pagination,
      },
      ["projectId"],
    ),
    outputSchema: paginatedIssues,
  },
  {
    name: "create_project_issue",
    description: "Create a new issue in a GitLab project.",
    inputSchema: input(
      {
        projectId,
        title: s.string({ minLength: 1, description: "The issue title." }),
        description: s.string({ minLength: 1, description: "The issue description." }),
        labels: s.string({ minLength: 1, description: "Comma-separated label names to attach to the issue." }),
        assigneeIds: s.array(s.integer({ description: "A GitLab user ID." }), {
          description: "User IDs to assign to the issue.",
        }),
        confidential: s.boolean({ description: "Whether the issue should be confidential." }),
        dueDate: s.string({ minLength: 1, description: "The issue due date in YYYY-MM-DD format." }),
      },
      ["projectId", "title"],
    ),
    outputSchema: issue,
  },
  {
    name: "update_project_issue",
    description: "Update an existing issue in a GitLab project, including closing or reopening it.",
    inputSchema: input(
      {
        projectId,
        issueIid,
        title: s.string({ minLength: 1, description: "The new issue title." }),
        description: s.string({ description: "The new issue description." }),
        labels: s.string({ description: "Comma-separated label names that replace all of the issue's labels." }),
        addLabels: s.string({ minLength: 1, description: "Comma-separated label names to add to the issue." }),
        removeLabels: s.string({ minLength: 1, description: "Comma-separated label names to remove from the issue." }),
        stateEvent: s.stringEnum(["close", "reopen"], { description: "Close or reopen the issue." }),
        assigneeIds: s.array(s.integer({ description: "A GitLab user ID." }), {
          description: "User IDs to assign to the issue.",
        }),
        confidential: s.boolean({ description: "Whether the issue should be confidential." }),
        dueDate: s.string({ minLength: 1, description: "The issue due date in YYYY-MM-DD format." }),
      },
      ["projectId", "issueIid"],
    ),
    outputSchema: issue,
  },
  {
    name: "create_issue_note",
    description: "Add a note (comment) to a GitLab project issue.",
    inputSchema: input(
      {
        projectId,
        issueIid,
        body: s.string({ minLength: 1, description: "The note body in GitLab-flavored Markdown." }),
      },
      ["projectId", "issueIid", "body"],
    ),
    outputSchema: note,
  },
  {
    name: "list_issue_notes",
    description: "List notes (comments) on a GitLab project issue.",
    inputSchema: input(
      {
        projectId,
        issueIid,
        sort: s.stringEnum(["asc", "desc"], { description: "Sort direction." }),
        orderBy: s.stringEnum(["created_at", "updated_at"], { description: "Sort notes by a GitLab-supported field." }),
        ...pagination,
      },
      ["projectId", "issueIid"],
    ),
    outputSchema: paginatedNotes,
  },
  {
    name: "list_commits",
    description: "List repository commits for a GitLab project, newest first by default.",
    inputSchema: input(
      {
        projectId,
        refName: s.string({
          minLength: 1,
          description: "The branch, tag, or commit to list from. Defaults to the project's default branch.",
        }),
        since: s.string({ minLength: 1, description: "Only commits after this ISO-8601 date." }),
        until: s.string({ minLength: 1, description: "Only commits before this ISO-8601 date." }),
        path: s.string({ minLength: 1, description: "Only commits that touch this file path." }),
        all: s.boolean({ description: "Retrieve commits from all branches and tags." }),
        withStats: s.boolean({ description: "Include per-commit stats (additions/deletions/total)." }),
        ...pagination,
      },
      ["projectId"],
    ),
    outputSchema: paginatedCommits,
  },
  {
    name: "get_commit",
    description: "Get a single repository commit by SHA (or a branch/tag name) for a GitLab project.",
    inputSchema: input({ projectId, sha }, ["projectId", "sha"]),
    outputSchema: commit,
  },
  {
    name: "list_branches",
    description: "List repository branches for a GitLab project, with an optional name filter.",
    inputSchema: input(
      {
        projectId,
        search: s.string({ minLength: 1, description: "Filter branches by name." }),
        ...pagination,
      },
      ["projectId"],
    ),
    outputSchema: paginatedBranches,
  },
];

export const gitlabActions: ActionDefinition[] = actions.map((action) =>
  defineProviderAction(service, {
    ...action,
    requiredScopes: [],
    providerPermissions: [],
  }),
);

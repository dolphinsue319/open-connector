import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "redmine";

const limitField = s.positiveInteger("Maximum number of results to return (1-100).", { maximum: 100 });
const offsetField = s.nonNegativeInteger("Number of results to skip for pagination.");
const includeField = s.stringArray("Associated data to include in the response.", {
  itemDescription: "An association name accepted by the Redmine include parameter.",
});
const isoDateField = s.string("Date in YYYY-MM-DD format, optionally with a Redmine filter operator.");

function idLikeField(description: string): JsonSchema {
  return s.union([s.nonEmptyString(description), s.positiveInteger(description)], { description });
}

const redmineNamedRefSchema = s.looseObject(
  {
    id: s.integer("Numeric identifier of the referenced record."),
    name: s.string("Display name of the referenced record."),
  },
  { description: "A named Redmine reference such as a project, tracker, or status." },
);

const redmineUserSchema = s.looseObject(
  {
    id: s.integer("Numeric user ID."),
    login: s.string("Login name of the user."),
    firstname: s.string("First name of the user."),
    lastname: s.string("Last name of the user."),
    mail: s.string("Email address of the user when visible."),
    admin: s.boolean("Whether the user is an administrator."),
    created_on: s.string("Timestamp when the account was created."),
    last_login_on: s.nullableString("Timestamp of the last login."),
  },
  { description: "A Redmine user record." },
);

const redmineIssueSchema = s.looseObject(
  {
    id: s.integer("Numeric issue ID."),
    project: redmineNamedRefSchema,
    tracker: redmineNamedRefSchema,
    status: redmineNamedRefSchema,
    priority: redmineNamedRefSchema,
    author: redmineNamedRefSchema,
    assigned_to: redmineNamedRefSchema,
    subject: s.string("Issue subject."),
    description: s.nullableString("Issue description in Textile or Markdown depending on instance settings."),
    start_date: s.nullableString("Issue start date."),
    due_date: s.nullableString("Issue due date."),
    done_ratio: s.integer("Percentage of completion."),
    estimated_hours: s.nullableNumber("Estimated hours for the issue."),
    is_private: s.boolean("Whether the issue is private."),
    created_on: s.string("Timestamp when the issue was created."),
    updated_on: s.string("Timestamp when the issue was last updated."),
    closed_on: s.nullableString("Timestamp when the issue was closed."),
  },
  { description: "A Redmine issue record." },
);

const redmineProjectSchema = s.looseObject(
  {
    id: s.integer("Numeric project ID."),
    name: s.string("Project name."),
    identifier: s.string("URL-safe project identifier."),
    description: s.nullableString("Project description."),
    status: s.integer("Project status code."),
    is_public: s.boolean("Whether the project is public."),
    parent: redmineNamedRefSchema,
    created_on: s.string("Timestamp when the project was created."),
    updated_on: s.string("Timestamp when the project was last updated."),
  },
  { description: "A Redmine project record." },
);

const redmineTimeEntrySchema = s.looseObject(
  {
    id: s.integer("Numeric time entry ID."),
    project: redmineNamedRefSchema,
    issue: s.looseObject(
      { id: s.integer("Numeric issue ID.") },
      { description: "The issue the time was logged against." },
    ),
    user: redmineNamedRefSchema,
    activity: redmineNamedRefSchema,
    hours: s.number("Number of hours logged."),
    comments: s.string("Comment attached to the time entry."),
    spent_on: s.string("Date the time was spent."),
    created_on: s.string("Timestamp when the time entry was created."),
    updated_on: s.string("Timestamp when the time entry was last updated."),
  },
  { description: "A Redmine time entry record." },
);

const redmineEnumerationSchema = s.looseObject(
  {
    id: s.integer("Numeric identifier."),
    name: s.string("Display name."),
    is_default: s.boolean("Whether this is the default value."),
    active: s.boolean("Whether the value is active."),
  },
  { description: "A Redmine enumeration value such as a tracker, status, priority, or activity." },
);

const redmineSearchResultSchema = s.looseObject(
  {
    id: s.integer("Numeric ID of the matched record."),
    title: s.string("Title of the matched record."),
    type: s.string("Type of the matched record such as issue or project."),
    url: s.string("URL of the matched record."),
    description: s.string("Excerpt describing the match."),
    datetime: s.string("Timestamp associated with the match."),
  },
  { description: "A Redmine search result." },
);

const issuesListSchema = s.actionOutput(
  {
    issues: s.array("Issues returned by the request.", redmineIssueSchema),
    total_count: s.integer("Total number of matching issues."),
    offset: s.integer("Offset applied to the result set."),
    limit: s.integer("Limit applied to the result set."),
  },
  "A paginated list of Redmine issues.",
  ["issues"],
);

const projectsListSchema = s.actionOutput(
  {
    projects: s.array("Projects returned by the request.", redmineProjectSchema),
    total_count: s.integer("Total number of matching projects."),
    offset: s.integer("Offset applied to the result set."),
    limit: s.integer("Limit applied to the result set."),
  },
  "A paginated list of Redmine projects.",
  ["projects"],
);

const timeEntriesListSchema = s.actionOutput(
  {
    time_entries: s.array("Time entries returned by the request.", redmineTimeEntrySchema),
    total_count: s.integer("Total number of matching time entries."),
    offset: s.integer("Offset applied to the result set."),
    limit: s.integer("Limit applied to the result set."),
  },
  "A paginated list of Redmine time entries.",
  ["time_entries"],
);

const searchResultsSchema = s.actionOutput(
  {
    results: s.array("Records matching the search query.", redmineSearchResultSchema),
    total_count: s.integer("Total number of matching records."),
    offset: s.integer("Offset applied to the result set."),
    limit: s.integer("Limit applied to the result set."),
  },
  "A paginated list of Redmine search results.",
  ["results"],
);

const updateResultSchema = s.actionOutput(
  {
    ok: s.boolean("Whether the update succeeded. Redmine returns an empty body for updates."),
    id: s.integer("ID of the updated issue."),
  },
  "The result of an issue update.",
  ["ok", "id"],
);

function enumerationListSchema(key: string, description: string): JsonSchema {
  return s.actionOutput(
    {
      [key]: s.array(description, redmineEnumerationSchema),
    },
    description,
    [key],
  );
}

const emptyInputSchema = s.object("The input payload for this action.", {});

export const redmineActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_current_user",
    description: "Get the Redmine user that owns the configured API key.",
    requiredScopes: [],
    inputSchema: emptyInputSchema,
    outputSchema: redmineUserSchema,
    followUpActions: ["redmine.list_issues", "redmine.list_projects"],
  }),
  defineProviderAction(service, {
    name: "list_issues",
    description: "List issues with optional filters such as project, tracker, status, and assignee.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        projectId: idLikeField("Project ID or identifier to filter issues by."),
        subprojectId: s.nonEmptyString("Subproject filter. Use !* to exclude subprojects."),
        trackerId: s.positiveInteger("Tracker ID to filter issues by."),
        statusId: s.nonEmptyString("Status filter: open, closed, *, or a numeric status ID."),
        priorityId: s.positiveInteger("Priority ID to filter issues by."),
        assignedToId: s.nonEmptyString("Assignee filter: a numeric user ID or 'me'."),
        authorId: s.nonEmptyString("Author filter: a numeric user ID or 'me'."),
        parentId: s.positiveInteger("Parent issue ID to filter child issues by."),
        createdOn: s.nonEmptyString("Created-on filter, optionally with a Redmine operator such as >=2026-01-01."),
        updatedOn: s.nonEmptyString("Updated-on filter, optionally with a Redmine operator."),
        sort: s.nonEmptyString("Sort column, for example 'updated_on:desc' or 'priority:desc'."),
        include: includeField,
        limit: limitField,
        offset: offsetField,
      },
      {
        optional: [
          "projectId",
          "subprojectId",
          "trackerId",
          "statusId",
          "priorityId",
          "assignedToId",
          "authorId",
          "parentId",
          "createdOn",
          "updatedOn",
          "sort",
          "include",
          "limit",
          "offset",
        ],
      },
    ),
    outputSchema: issuesListSchema,
    followUpActions: ["redmine.get_issue", "redmine.create_issue"],
  }),
  defineProviderAction(service, {
    name: "get_issue",
    description: "Get one Redmine issue by ID, including journals, attachments, and relations by default.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        id: s.positiveInteger("Numeric ID of the issue."),
        include: includeField,
      },
      { optional: ["include"] },
    ),
    outputSchema: redmineIssueSchema,
    followUpActions: ["redmine.update_issue", "redmine.create_time_entry"],
  }),
  defineProviderAction(service, {
    name: "create_issue",
    description: "Create a new Redmine issue in a project.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        projectId: idLikeField("Project ID or identifier the issue belongs to."),
        subject: s.nonEmptyString("Subject of the issue."),
        description: s.string("Description of the issue."),
        trackerId: s.positiveInteger("Tracker ID for the issue."),
        statusId: s.positiveInteger("Initial status ID for the issue."),
        priorityId: s.positiveInteger("Priority ID for the issue."),
        assignedToId: s.positiveInteger("User ID to assign the issue to."),
        categoryId: s.positiveInteger("Issue category ID."),
        fixedVersionId: s.positiveInteger("Target version ID for the issue."),
        parentIssueId: s.positiveInteger("Parent issue ID."),
        startDate: isoDateField,
        dueDate: isoDateField,
        estimatedHours: s.number("Estimated hours for the issue."),
        doneRatio: s.integer("Percentage of completion (0-100).", { minimum: 0, maximum: 100 }),
        isPrivate: s.boolean("Whether the issue should be private."),
        watcherUserIds: s.array("User IDs to add as watchers.", s.positiveInteger("A watcher user ID.")),
      },
      {
        optional: [
          "description",
          "trackerId",
          "statusId",
          "priorityId",
          "assignedToId",
          "categoryId",
          "fixedVersionId",
          "parentIssueId",
          "startDate",
          "dueDate",
          "estimatedHours",
          "doneRatio",
          "isPrivate",
          "watcherUserIds",
        ],
      },
    ),
    outputSchema: redmineIssueSchema,
    followUpActions: ["redmine.create_time_entry"],
  }),
  defineProviderAction(service, {
    name: "update_issue",
    description:
      "Update a Redmine issue. Pass notes to append a journal entry, or change status, assignee, and other fields.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        id: s.positiveInteger("Numeric ID of the issue to update."),
        subject: s.nonEmptyString("New subject for the issue."),
        description: s.string("New description for the issue."),
        trackerId: s.positiveInteger("New tracker ID."),
        statusId: s.positiveInteger("New status ID."),
        priorityId: s.positiveInteger("New priority ID."),
        assignedToId: s.positiveInteger("User ID to reassign the issue to."),
        categoryId: s.positiveInteger("New issue category ID."),
        fixedVersionId: s.positiveInteger("New target version ID."),
        parentIssueId: s.positiveInteger("New parent issue ID."),
        startDate: isoDateField,
        dueDate: isoDateField,
        estimatedHours: s.number("New estimated hours."),
        doneRatio: s.integer("New percentage of completion (0-100).", { minimum: 0, maximum: 100 }),
        isPrivate: s.boolean("Whether the issue should be private."),
        notes: s.string("Journal note to append to the issue."),
        privateNotes: s.boolean("Whether the appended note should be private."),
      },
      {
        optional: [
          "subject",
          "description",
          "trackerId",
          "statusId",
          "priorityId",
          "assignedToId",
          "categoryId",
          "fixedVersionId",
          "parentIssueId",
          "startDate",
          "dueDate",
          "estimatedHours",
          "doneRatio",
          "isPrivate",
          "notes",
          "privateNotes",
        ],
      },
    ),
    outputSchema: updateResultSchema,
    followUpActions: ["redmine.get_issue"],
  }),
  defineProviderAction(service, {
    name: "list_projects",
    description: "List Redmine projects visible to the API key.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        include: includeField,
        limit: limitField,
        offset: offsetField,
      },
      { optional: ["include", "limit", "offset"] },
    ),
    outputSchema: projectsListSchema,
    followUpActions: ["redmine.get_project", "redmine.list_issues"],
  }),
  defineProviderAction(service, {
    name: "get_project",
    description: "Get one Redmine project by numeric ID or identifier.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        id: idLikeField("Numeric ID or identifier of the project."),
        include: includeField,
      },
      { optional: ["include"] },
    ),
    outputSchema: redmineProjectSchema,
    followUpActions: ["redmine.list_issues"],
  }),
  defineProviderAction(service, {
    name: "create_time_entry",
    description: "Log a time entry against an issue or project.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        issueId: s.positiveInteger("Issue ID to log time against. Provide this or projectId."),
        projectId: idLikeField("Project ID or identifier to log time against. Provide this or issueId."),
        hours: s.number("Number of hours to log."),
        activityId: s.positiveInteger("Time entry activity ID."),
        spentOn: isoDateField,
        comments: s.string("Short comment describing the logged time."),
        userId: s.positiveInteger("User ID to attribute the time entry to. Requires admin privileges."),
      },
      { optional: ["issueId", "projectId", "spentOn", "comments", "userId"] },
    ),
    outputSchema: redmineTimeEntrySchema,
  }),
  defineProviderAction(service, {
    name: "list_time_entries",
    description: "List time entries with optional user, project, issue, and date filters.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        userId: s.nonEmptyString("User filter: a numeric user ID or 'me'."),
        projectId: s.nonEmptyString("Project ID or identifier to filter by."),
        issueId: s.positiveInteger("Issue ID to filter by."),
        spentOn: isoDateField,
        from: isoDateField,
        to: isoDateField,
        limit: limitField,
        offset: offsetField,
      },
      { optional: ["userId", "projectId", "issueId", "spentOn", "from", "to", "limit", "offset"] },
    ),
    outputSchema: timeEntriesListSchema,
  }),
  defineProviderAction(service, {
    name: "search",
    description: "Search across Redmine records such as issues, projects, wiki pages, and news.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for this action.",
      {
        query: s.nonEmptyString("Search keywords."),
        scope: s.stringEnum("Search scope.", ["all", "my_projects", "subprojects"]),
        allWords: s.boolean("Whether every word must match."),
        titlesOnly: s.boolean("Whether to match titles only."),
        openIssues: s.boolean("Whether to restrict issue matches to open issues."),
        issues: s.boolean("Whether to include issues in the results."),
        news: s.boolean("Whether to include news in the results."),
        documents: s.boolean("Whether to include documents in the results."),
        changesets: s.boolean("Whether to include changesets in the results."),
        wikiPages: s.boolean("Whether to include wiki pages in the results."),
        messages: s.boolean("Whether to include forum messages in the results."),
        projects: s.boolean("Whether to include projects in the results."),
        limit: limitField,
        offset: offsetField,
      },
      {
        optional: [
          "scope",
          "allWords",
          "titlesOnly",
          "openIssues",
          "issues",
          "news",
          "documents",
          "changesets",
          "wikiPages",
          "messages",
          "projects",
          "limit",
          "offset",
        ],
      },
    ),
    outputSchema: searchResultsSchema,
  }),
  defineProviderAction(service, {
    name: "list_trackers",
    description: "List issue trackers configured on the Redmine instance.",
    requiredScopes: [],
    inputSchema: emptyInputSchema,
    outputSchema: enumerationListSchema("trackers", "Trackers configured on the instance."),
  }),
  defineProviderAction(service, {
    name: "list_issue_statuses",
    description: "List issue statuses configured on the Redmine instance.",
    requiredScopes: [],
    inputSchema: emptyInputSchema,
    outputSchema: enumerationListSchema("issue_statuses", "Issue statuses configured on the instance."),
  }),
  defineProviderAction(service, {
    name: "list_issue_priorities",
    description: "List issue priority enumeration values configured on the Redmine instance.",
    requiredScopes: [],
    inputSchema: emptyInputSchema,
    outputSchema: enumerationListSchema("issue_priorities", "Issue priorities configured on the instance."),
  }),
  defineProviderAction(service, {
    name: "list_time_entry_activities",
    description: "List time entry activity enumeration values configured on the Redmine instance.",
    requiredScopes: [],
    inputSchema: emptyInputSchema,
    outputSchema: enumerationListSchema("time_entry_activities", "Time entry activities configured on the instance."),
  }),
];

export type RedmineActionName =
  | "get_current_user"
  | "list_issues"
  | "get_issue"
  | "create_issue"
  | "update_issue"
  | "list_projects"
  | "get_project"
  | "create_time_entry"
  | "list_time_entries"
  | "search"
  | "list_trackers"
  | "list_issue_statuses"
  | "list_issue_priorities"
  | "list_time_entry_activities";

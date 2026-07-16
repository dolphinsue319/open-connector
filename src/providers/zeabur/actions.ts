import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "zeabur";

const environmentSchema = s.looseObject("A Zeabur environment.", {
  id: s.string("The environment id, used as environmentId in other actions."),
  name: s.string("The environment name, such as production."),
});

const serviceRefSchema = s.looseObject("A service belonging to a project.", {
  id: s.string("The service id, used as serviceId in other actions."),
  name: s.string("The service name."),
  template: s.string("The service template, such as PREBUILT_V2 or GIT."),
});

const projectSchema = s.looseObject("A Zeabur project.", {
  id: s.string("The project id."),
  name: s.string("The project name."),
  description: s.string("The project description."),
  createdAt: s.string("When the project was created."),
  region: s.string("The region id the project runs in, such as tpe1."),
  environments: s.array("Environments in the project.", environmentSchema),
  services: s.array("Services in the project.", serviceRefSchema),
});

const serviceSchema = s.looseObject("A Zeabur service.", {
  id: s.string("The service id."),
  name: s.string("The service name."),
  template: s.string("The service template, such as PREBUILT_V2 or GIT."),
  dnsName: s.string("The internal DNS name of the service."),
  createdAt: s.string("When the service was created."),
  status: s.string("The current status in the requested environment."),
});

const deploymentSchema = s.looseObject("A Zeabur deployment.", {
  id: s.string("The deployment id, used as deploymentId in other actions."),
  status: s.string("The deployment status."),
  ref: s.string("The git ref that produced the deployment."),
  commitSHA: s.string("The deployed commit SHA."),
  commitMessage: s.string("The deployed commit message."),
  createdAt: s.string("When the deployment was created."),
  finishedAt: s.string("When the deployment finished."),
  cursor: s.string("Pass as the cursor input to page past this deployment."),
});

const logSchema = s.looseObject("A log line.", {
  message: s.string("The log message."),
  timestamp: s.string("When the line was emitted."),
  stream: s.string("The originating stream, such as stdout or stderr."),
  region: s.string("The region that emitted the line."),
});

const envVarSchema = s.looseObject("An environment variable. The value is masked unless reveal was set.", {
  key: s.string("The variable name."),
  value: s.string("The plaintext value. Only present when reveal was true."),
  valuePreview: s.string("A masked preview of the value. Only present when reveal was false."),
  masked: s.boolean("Whether the value was masked."),
  exposed: s.boolean("Whether the variable is exposed to other services in the project."),
  readonly: s.boolean("Whether the variable is managed by Zeabur and cannot be edited."),
});

const serviceTarget = {
  serviceId: s.nonEmptyString("The service id, from list_projects or list_services."),
  environmentId: s.nonEmptyString("The environment id, from list_projects or list_environments."),
};

export const zeaburActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_projects",
    description:
      "List Zeabur projects for the authenticated account, including each project's environments and services. Use this first to discover the projectId, environmentId, and serviceId that other Zeabur actions require.",
    inputSchema: s.actionInput(
      {
        skip: s.nonNegativeInteger("How many projects to skip before returning results."),
        limit: s.positiveInteger("The maximum number of projects to return."),
      },
      [],
      "The input payload for listing Zeabur projects.",
    ),
    outputSchema: s.actionOutput({ projects: s.array("The projects visible to the account.", projectSchema) }),
  }),
  defineProviderAction(service, {
    name: "get_project",
    description:
      "Get one Zeabur project with its environments and services. Look it up by projectId, or by owner plus name.",
    inputSchema: s.actionInput(
      {
        projectId: s.nonEmptyString("The project id."),
        owner: s.nonEmptyString("The project owner username. Use together with name instead of projectId."),
        name: s.nonEmptyString("The project name. Use together with owner instead of projectId."),
      },
      [],
      "Identify the project by projectId, or by owner and name.",
    ),
    outputSchema: projectSchema,
  }),
  defineProviderAction(service, {
    name: "list_services",
    description: "List the services in one Zeabur project.",
    inputSchema: s.actionInput(
      {
        projectId: s.nonEmptyString("The project id."),
        skip: s.nonNegativeInteger("How many services to skip before returning results."),
        limit: s.positiveInteger("The maximum number of services to return."),
      },
      ["projectId"],
      "The input payload for listing services in a project.",
    ),
    outputSchema: s.actionOutput({ services: s.array("The services in the project.", serviceSchema) }),
  }),
  defineProviderAction(service, {
    name: "get_service",
    description: "Get one Zeabur service, including its current running status in the given environment.",
    inputSchema: s.actionInput(serviceTarget, ["serviceId", "environmentId"], "Identify the service and environment."),
    outputSchema: serviceSchema,
  }),
  defineProviderAction(service, {
    name: "list_environments",
    description: "List the environments in one Zeabur project.",
    inputSchema: s.actionInput(
      { projectId: s.nonEmptyString("The project id.") },
      ["projectId"],
      "The input payload for listing environments.",
    ),
    outputSchema: s.actionOutput({ environments: s.array("The environments in the project.", environmentSchema) }),
  }),
  defineProviderAction(service, {
    name: "list_deployments",
    description: "List deployments for one Zeabur service, newest first.",
    inputSchema: s.actionInput(
      {
        ...serviceTarget,
        cursor: s.nonEmptyString("Return deployments after this cursor, taken from a previous page."),
        perPage: s.positiveInteger("The maximum number of deployments to return."),
        filter: s.stringEnum("Return only deployments in this status.", [
          "PENDING",
          "FAILED",
          "BUILDING",
          "DEPLOYING",
          "RUNNING",
          "REMOVED",
          "CRASHED",
          "CANCELED",
          "UNKNOWN",
        ]),
      },
      ["serviceId", "environmentId"],
      "The input payload for listing deployments.",
    ),
    outputSchema: s.actionOutput({ deployments: s.array("The deployments for the service.", deploymentSchema) }),
  }),
  defineProviderAction(service, {
    name: "list_env_vars",
    description:
      "List the environment variables of one Zeabur service. Values are masked by default because they routinely hold database passwords, JWT secrets, and API keys. Set reveal to true only when the plaintext is actually needed.",
    inputSchema: s.actionInput(
      {
        ...serviceTarget,
        reveal: s.boolean({
          description:
            "Return plaintext values instead of masked previews. Leave unset unless the caller needs the real values.",
          default: false,
        }),
      },
      ["serviceId", "environmentId"],
      "The input payload for reading environment variables.",
    ),
    outputSchema: s.actionOutput({ variables: s.array("The environment variables of the service.", envVarSchema) }),
  }),
  defineProviderAction(service, {
    name: "get_build_logs",
    description: "Get the build logs of one Zeabur deployment.",
    inputSchema: s.actionInput(
      {
        deploymentId: s.nonEmptyString("The deployment id, from list_deployments."),
        projectId: s.nonEmptyString("The project id that owns the deployment."),
        timestampCursor: s.nonEmptyString("Return only lines emitted after this RFC 3339 timestamp."),
      },
      ["deploymentId"],
      "The input payload for reading build logs.",
    ),
    outputSchema: s.actionOutput({ logs: s.array("The build log lines.", logSchema) }),
  }),
  defineProviderAction(service, {
    name: "get_runtime_logs",
    description:
      "Get the runtime logs of one Zeabur service. Zeabur retains runtime logs for a limited window, so an empty result can mean the service has simply been quiet.",
    inputSchema: s.actionInput(
      {
        ...serviceTarget,
        deploymentId: s.nonEmptyString("Restrict the logs to one deployment."),
        timestampCursor: s.nonEmptyString("Return only lines emitted after this RFC 3339 timestamp."),
      },
      ["serviceId"],
      "The input payload for reading runtime logs.",
    ),
    outputSchema: s.actionOutput({ logs: s.array("The runtime log lines.", logSchema) }),
  }),
  defineProviderAction(service, {
    name: "search_runtime_logs",
    description:
      "Search the runtime logs of one Zeabur service for a query string. Zeabur gates this behind the Pro and Team plans; on other plans it fails with a permission error and get_runtime_logs is the alternative.",
    inputSchema: s.actionInput(
      {
        ...serviceTarget,
        query: s.nonEmptyString("The text to search for in the log messages."),
        deploymentId: s.nonEmptyString("Restrict the search to one deployment."),
        limit: s.positiveInteger("The maximum number of matching lines to return."),
        startTime: s.nonEmptyString("Search only lines at or after this RFC 3339 timestamp."),
        endTime: s.nonEmptyString("Search only lines at or before this RFC 3339 timestamp."),
      },
      ["serviceId", "query"],
      "The input payload for searching runtime logs.",
    ),
    outputSchema: s.actionOutput({ logs: s.array("The matching runtime log lines.", logSchema) }),
  }),
  defineProviderAction(service, {
    name: "set_env_var",
    description:
      "Create or update one environment variable on a Zeabur service, leaving every other variable untouched. Zeabur does not restart the service afterwards: the running container keeps serving the old value until restart_service or redeploy_service runs.",
    inputSchema: s.actionInput(
      {
        ...serviceTarget,
        key: s.nonEmptyString("The variable name to create or update."),
        value: s.string("The value to store."),
      },
      ["serviceId", "environmentId", "key", "value"],
      "The input payload for setting one environment variable.",
    ),
    outputSchema: s.actionOutput(
      {
        key: s.string("The variable that was written."),
        created: s.boolean("True when the variable was new, false when an existing one was updated."),
        variableCount: s.integer(
          "How many variables the service has now. Compare it against the count before the write. Absent when the write landed but the count could not be read back.",
        ),
      },
      "The result of writing one environment variable.",
      ["key", "created"],
    ),
    followUpActions: ["zeabur.restart_service"],
  }),
  defineProviderAction(service, {
    name: "delete_env_var",
    description:
      "Delete one environment variable from a Zeabur service, leaving every other variable untouched. The running container keeps the old value until the service restarts.",
    inputSchema: s.actionInput(
      { ...serviceTarget, key: s.nonEmptyString("The variable name to delete.") },
      ["serviceId", "environmentId", "key"],
      "The input payload for deleting one environment variable.",
    ),
    outputSchema: s.actionOutput({
      key: s.string("The variable that was deleted."),
      deleted: s.boolean("Whether the delete was applied."),
      variableCount: s.integer("How many variables remain on the service."),
    }),
    followUpActions: ["zeabur.restart_service"],
  }),
  defineProviderAction(service, {
    name: "restart_service",
    description:
      "Restart a running Zeabur service. This interrupts the service briefly and is how environment variable changes take effect.",
    inputSchema: s.actionInput(serviceTarget, ["serviceId", "environmentId"], "Identify the service and environment."),
    outputSchema: s.actionOutput({ success: s.boolean("Whether Zeabur accepted the restart.") }),
  }),
  defineProviderAction(service, {
    name: "redeploy_service",
    description:
      "Redeploy a Zeabur service, rebuilding it from its current source. Slower than restart_service and it replaces the running deployment.",
    inputSchema: s.actionInput(serviceTarget, ["serviceId", "environmentId"], "Identify the service and environment."),
    outputSchema: s.actionOutput({ success: s.boolean("Whether Zeabur accepted the redeploy.") }),
  }),
  defineProviderAction(service, {
    name: "update_service_image_tag",
    description:
      "Point a Docker-image-backed Zeabur service at a different image tag. Zeabur redeploys the service onto the new tag.",
    inputSchema: s.actionInput(
      { ...serviceTarget, tag: s.nonEmptyString("The image tag to deploy, such as v1.2.3 or latest.") },
      ["serviceId", "environmentId", "tag"],
      "The input payload for changing the image tag.",
    ),
    outputSchema: s.actionOutput({ success: s.boolean("Whether Zeabur accepted the tag change.") }),
  }),
  defineProviderAction(service, {
    name: "rollback_deployment",
    description:
      "Roll a Zeabur service back to an earlier deployment. Pass a deploymentId from list_deployments; it becomes the live deployment again.",
    inputSchema: s.actionInput(
      { deploymentId: s.nonEmptyString("The deployment id to roll back to, from list_deployments.") },
      ["deploymentId"],
      "The input payload for rolling back a deployment.",
    ),
    outputSchema: s.actionOutput({ success: s.boolean("Whether Zeabur accepted the rollback.") }),
  }),
];

export type ZeaburActionName = (typeof zeaburActions)[number]["name"];

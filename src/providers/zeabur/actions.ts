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
];

export type ZeaburActionName = (typeof zeaburActions)[number]["name"];

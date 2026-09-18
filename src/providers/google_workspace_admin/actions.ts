import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { googleWorkspaceAdminAliasReadScopes, googleWorkspaceAdminAliasWriteScopes } from "./scopes.ts";

const service = "google_workspace_admin";

const userKey = s.nonWhitespaceString(
  "Primary email address or unique user ID of the Workspace user who owns the aliases, for example admin@example.com.",
);
const aliasAddress = s.email(
  "Full alias email address. The domain must be a domain or domain alias verified in this Workspace account.",
);
const alias = s.requiredObject("A normalized Google Workspace user email alias.", {
  id: s.string("Unique ID of the user who owns the alias."),
  primaryEmail: s.nullableString(
    "Primary email address of the user who owns the alias. Null when Google omits it, as it does in the create response.",
  ),
  alias: s.string("Alias email address."),
  etag: s.nullableString("Entity tag for the alias resource."),
});

export const googleWorkspaceAdminActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_user_aliases",
    description:
      "List the email aliases attached to a Google Workspace user. Mail sent to any alias is delivered to the user's primary inbox and can be read with the Gmail provider action fetch_emails using the query to:<alias>.",
    requiredScopes: googleWorkspaceAdminAliasReadScopes,
    providerPermissions: googleWorkspaceAdminAliasReadScopes,
    inputSchema: s.actionInput({ userKey }, ["userKey"]),
    outputSchema: s.actionOutput({ aliases: s.array("Aliases attached to the user.", alias) }),
  }),
  defineProviderAction(service, {
    name: "create_user_alias",
    description:
      "Add an email alias to a Google Workspace user. Mail sent to the alias lands in the user's primary inbox, so it can be read with the Gmail provider action fetch_emails using the query to:<alias>. Each user can hold at most 30 aliases.",
    requiredScopes: googleWorkspaceAdminAliasWriteScopes,
    providerPermissions: googleWorkspaceAdminAliasWriteScopes,
    inputSchema: s.actionInput({ userKey, alias: aliasAddress }, ["userKey", "alias"]),
    outputSchema: s.actionOutput({ alias }),
  }),
  defineProviderAction(service, {
    name: "delete_user_alias",
    description: "Remove an email alias from a Google Workspace user. Mail sent to the alias afterwards bounces.",
    requiredScopes: googleWorkspaceAdminAliasWriteScopes,
    providerPermissions: googleWorkspaceAdminAliasWriteScopes,
    inputSchema: s.actionInput({ userKey, alias: aliasAddress }, ["userKey", "alias"]),
    outputSchema: s.actionOutput({
      deleted: s.literal(true, { description: "Whether the alias was removed." }),
      alias: s.string("Alias email address that was removed."),
    }),
  }),
];

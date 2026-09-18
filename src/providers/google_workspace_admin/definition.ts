import type { ProviderDefinition } from "../../core/types.ts";

import { googleWorkspaceAdminActions } from "./actions.ts";
import { googleWorkspaceAdminOAuthScopes } from "./scopes.ts";

const service = "google_workspace_admin";

/**
 * Google Workspace Admin provider backed by the Admin SDK Directory API and a user-provided Google OAuth app.
 * The authorizing account must hold Workspace admin privileges for the managed domain.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Google Workspace Admin",
  categories: ["Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: googleWorkspaceAdminOAuthScopes,
      tokenEndpointAuthMethod: "client_secret_post",
      authorizationParams: {
        access_type: "offline",
        prompt: "consent",
      },
    },
  ],
  homepageUrl: "https://admin.google.com",
  actions: googleWorkspaceAdminActions,
};

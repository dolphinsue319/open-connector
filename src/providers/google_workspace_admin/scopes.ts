export const googleWorkspaceAdminUserAliasScope = "https://www.googleapis.com/auth/admin.directory.user.alias";
export const googleWorkspaceAdminUserAliasReadonlyScope =
  "https://www.googleapis.com/auth/admin.directory.user.alias.readonly";
export const googleOpenIdScope = "openid";
export const googleEmailScope = "email";
export const googleProfileScope = "profile";

export const googleWorkspaceAdminAliasReadScopes: string[] = [googleWorkspaceAdminUserAliasReadonlyScope];
export const googleWorkspaceAdminAliasWriteScopes: string[] = [googleWorkspaceAdminUserAliasScope];
export const googleWorkspaceAdminOAuthScopes: string[] = [
  googleWorkspaceAdminUserAliasReadonlyScope,
  googleWorkspaceAdminUserAliasScope,
  googleOpenIdScope,
  googleEmailScope,
  googleProfileScope,
];

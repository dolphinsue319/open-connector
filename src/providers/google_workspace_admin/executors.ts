import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { OAuthProviderContext, ProviderActionHandlers } from "../provider-runtime.ts";

import { optionalStringOrNull, requiredString } from "../../core/cast.ts";
import { googleJsonRequest, googleRequest } from "../google-runtime.ts";
import { defineOAuthProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";

const service = "google_workspace_admin";
const directoryApiBaseUrl = "https://admin.googleapis.com/admin/directory/v1";
const googleUserInfoUrl = "https://www.googleapis.com/oauth2/v3/userinfo";

type GoogleWorkspaceAdminActionHandler = (
  input: Record<string, unknown>,
  context: OAuthProviderContext,
) => Promise<unknown>;

interface AliasPayload {
  id?: string;
  etag?: string;
  primaryEmail?: string;
  alias?: string;
}

interface AliasCollectionPayload {
  aliases?: AliasPayload[];
}

interface NormalizedAlias {
  id: string;
  primaryEmail: string;
  alias: string;
  etag: string | null;
}

interface DirectoryRequestInput {
  context: OAuthProviderContext;
  method?: string;
  body?: unknown;
}

export const googleWorkspaceAdminActionHandlers: ProviderActionHandlers<
  "google_workspace_admin",
  GoogleWorkspaceAdminActionHandler
> = {
  list_user_aliases: listUserAliases,
  create_user_alias: createUserAlias,
  delete_user_alias: deleteUserAlias,
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, googleWorkspaceAdminActionHandlers);

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const context: OAuthProviderContext = { accessToken: input.accessToken, fetcher, signal };
    const profile = await googleJsonRequest<{
      email?: string;
      name?: string;
      sub?: string;
    }>(googleUserInfoUrl, { ...context, service });
    // A live Google token is not enough: the account must also be allowed to call the Admin SDK for its domain.
    // Reading the account's own aliases is the cheapest Directory call covered by the requested scopes.
    if (profile.email) {
      await directoryJsonRequest<AliasCollectionPayload>(userAliasesPath(profile.email), { context });
    }
    return {
      profile: {
        accountId: profile.email ?? profile.sub ?? "google_workspace_admin:oauth2",
        displayName: profile.name ?? profile.email ?? "Google Workspace Admin",
      },
      metadata: {
        currentAccount: profile,
      },
    };
  },
};

async function listUserAliases(input: Record<string, unknown>, context: OAuthProviderContext) {
  const userKey = requiredString(input.userKey, "userKey", inputError);
  const payload = await directoryJsonRequest<AliasCollectionPayload>(userAliasesPath(userKey), { context });
  return { aliases: (payload.aliases ?? []).map(normalizeAlias) };
}

async function createUserAlias(input: Record<string, unknown>, context: OAuthProviderContext) {
  const userKey = requiredString(input.userKey, "userKey", inputError);
  const alias = requiredString(input.alias, "alias", inputError);
  const payload = await directoryJsonRequest<AliasPayload>(userAliasesPath(userKey), {
    context,
    method: "POST",
    body: { alias },
  });
  return { alias: normalizeAlias(payload) };
}

async function deleteUserAlias(input: Record<string, unknown>, context: OAuthProviderContext) {
  const userKey = requiredString(input.userKey, "userKey", inputError);
  const alias = requiredString(input.alias, "alias", inputError);
  await directoryRequest(`${userAliasesPath(userKey)}/${encodeURIComponent(alias)}`, { context, method: "DELETE" });
  return { deleted: true, alias };
}

function userAliasesPath(userKey: string): string {
  return `/users/${encodeURIComponent(userKey)}/aliases`;
}

function normalizeAlias(payload: AliasPayload): NormalizedAlias {
  return {
    id: requiredString(payload.id, "Google Workspace alias response field id", upstreamError),
    primaryEmail: requiredString(
      payload.primaryEmail,
      "Google Workspace alias response field primaryEmail",
      upstreamError,
    ),
    alias: requiredString(payload.alias, "Google Workspace alias response field alias", upstreamError),
    etag: optionalStringOrNull(payload.etag),
  };
}

function directoryRequest(path: string, input: DirectoryRequestInput): Promise<Response> {
  return googleRequest(`${directoryApiBaseUrl}${path}`, {
    accessToken: input.context.accessToken,
    fetcher: input.context.fetcher,
    signal: input.context.signal,
    method: input.method,
    body: input.body,
    service,
  });
}

async function directoryJsonRequest<T>(path: string, input: DirectoryRequestInput): Promise<T> {
  const response = await directoryRequest(path, input);
  return (await response.json()) as T;
}

function inputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function upstreamError(message: string): ProviderRequestError {
  return new ProviderRequestError(502, message);
}

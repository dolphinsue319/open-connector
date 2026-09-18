import type { ProviderFetch } from "../provider-runtime.ts";

import { describe, expect, it } from "vitest";
import { credentialValidators, googleWorkspaceAdminActionHandlers } from "./executors.ts";

const accessToken = "workspace-admin-token";
const aliasesPath = "/admin/directory/v1/users/owner%40example.com/aliases";

interface RecordedRequest {
  method: string;
  url: URL;
  body: string | null;
  authorization: string | null;
}

function recordingFetcher(respond: (request: RecordedRequest) => Response): {
  fetcher: ProviderFetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url: new URL(url.toString()),
      body: typeof init?.body === "string" ? init.body : null,
      authorization: new Headers(init?.headers).get("authorization"),
    };
    requests.push(request);
    return respond(request);
  }) as ProviderFetch;
  return { fetcher, requests };
}

describe("Google Workspace Admin alias handlers", () => {
  it("lists aliases for a user and normalizes each entry", async () => {
    const { fetcher, requests } = recordingFetcher(() =>
      Response.json({
        kind: "admin#directory#aliases",
        aliases: [
          {
            kind: "admin#directory#alias",
            id: "1001",
            etag: '"etag-1"',
            primaryEmail: "owner@example.com",
            alias: "verify-1@example.com",
          },
          { id: "1001", primaryEmail: "owner@example.com", alias: "verify-2@example.com" },
        ],
      }),
    );

    const result = await googleWorkspaceAdminActionHandlers.list_user_aliases(
      { userKey: "owner@example.com" },
      { accessToken, fetcher },
    );

    expect(requests[0]).toMatchObject({ method: "GET", authorization: `Bearer ${accessToken}` });
    expect(requests[0]?.url.pathname).toBe(aliasesPath);
    expect(result).toEqual({
      aliases: [
        { id: "1001", primaryEmail: "owner@example.com", alias: "verify-1@example.com", etag: '"etag-1"' },
        { id: "1001", primaryEmail: "owner@example.com", alias: "verify-2@example.com", etag: null },
      ],
    });
  });

  it("returns an empty list when the user has no aliases", async () => {
    const { fetcher } = recordingFetcher(() => Response.json({ kind: "admin#directory#aliases" }));

    const result = await googleWorkspaceAdminActionHandlers.list_user_aliases(
      { userKey: "owner@example.com" },
      { accessToken, fetcher },
    );

    expect(result).toEqual({ aliases: [] });
  });

  it("creates an alias by posting only the alias address and tolerates the live response omitting primaryEmail", async () => {
    const { fetcher, requests } = recordingFetcher(() =>
      Response.json({
        kind: "admin#directory#alias",
        id: "1001",
        etag: '"etag-new"',
        alias: "verify-3@example.com",
      }),
    );

    const result = await googleWorkspaceAdminActionHandlers.create_user_alias(
      { userKey: "owner@example.com", alias: "verify-3@example.com" },
      { accessToken, fetcher },
    );

    expect(requests[0]).toMatchObject({ method: "POST", body: JSON.stringify({ alias: "verify-3@example.com" }) });
    expect(requests[0]?.url.pathname).toBe(aliasesPath);
    expect(result).toEqual({
      alias: { id: "1001", primaryEmail: null, alias: "verify-3@example.com", etag: '"etag-new"' },
    });
  });

  it("surfaces the Google error message when the alias already exists", async () => {
    const { fetcher } = recordingFetcher(
      () =>
        new Response(JSON.stringify({ error: { code: 409, message: "Entity already exists." } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      googleWorkspaceAdminActionHandlers.create_user_alias(
        { userKey: "owner@example.com", alias: "verify-3@example.com" },
        { accessToken, fetcher },
      ),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Entity already exists.") });
  });

  it("deletes an alias with a bodyless DELETE and reports the removed address", async () => {
    const { fetcher, requests } = recordingFetcher(() => new Response(null, { status: 204 }));

    const result = await googleWorkspaceAdminActionHandlers.delete_user_alias(
      { userKey: "owner@example.com", alias: "verify-3@example.com" },
      { accessToken, fetcher },
    );

    expect(requests[0]).toMatchObject({ method: "DELETE", body: null });
    expect(requests[0]?.url.pathname).toBe(`${aliasesPath}/verify-3%40example.com`);
    expect(result).toEqual({ deleted: true, alias: "verify-3@example.com" });
  });
});

describe("Google Workspace Admin credentials", () => {
  const oauthInput = {
    authType: "oauth2" as const,
    accessToken,
    tokenType: "bearer",
    profile: { accountId: "oauth2", displayName: "OAuth Credential", grantedScopes: [] },
    metadata: {},
  };

  it("validates by reading the account identity and then probing the Directory API as that user", async () => {
    const { fetcher, requests } = recordingFetcher((request) =>
      request.url.pathname === "/oauth2/v3/userinfo"
        ? Response.json({ sub: "42", email: "admin@example.com", name: "Workspace Admin" })
        : Response.json({ kind: "admin#directory#aliases" }),
    );

    const result = await credentialValidators.oauth2!(oauthInput, { fetcher });

    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/oauth2/v3/userinfo",
      "/admin/directory/v1/users/admin%40example.com/aliases",
    ]);
    expect(requests.every((request) => request.authorization === `Bearer ${accessToken}`)).toBe(true);
    expect(result).toMatchObject({
      profile: { accountId: "admin@example.com", displayName: "Workspace Admin" },
    });
  });

  it("fails validation with Google's reason when the account cannot use the Admin SDK", async () => {
    const { fetcher } = recordingFetcher((request) =>
      request.url.pathname === "/oauth2/v3/userinfo"
        ? Response.json({ sub: "42", email: "user@example.com" })
        : new Response(
            JSON.stringify({ error: { code: 403, message: "Not Authorized to access this resource/api" } }),
            {
              status: 403,
              headers: { "content-type": "application/json" },
            },
          ),
    );

    await expect(credentialValidators.oauth2!(oauthInput, { fetcher })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("Not Authorized"),
    });
  });
});

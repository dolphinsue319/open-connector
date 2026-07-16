import { afterEach, describe, expect, it, vi } from "vitest";

import { apiKeyCredential } from "../provider-proxy-loader.test-helpers.ts";
import { credentialValidators, executors } from "./executors.ts";
import { maskSecret, zeaburApiUrl } from "./runtime.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function graphqlCall(fetcher: ReturnType<typeof vi.fn>, index = 0): { query: string; variables: Record<string, unknown> } {
  const init = fetcher.mock.calls[index]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
}

const credential = { getCredential: async (): Promise<ReturnType<typeof apiKeyCredential>> => apiKeyCredential("sk-token") };

describe("zeabur graphql transport", () => {
  it("posts a bearer-authenticated GraphQL query and unwraps data", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        data: {
          projects: {
            edges: [
              {
                node: {
                  _id: "p1",
                  name: "kd-ttc-dev",
                  region: { id: "tpe1" },
                  environments: [{ _id: "e1", name: "production" }],
                  services: [{ _id: "s1", name: "kd-ttc", template: "PREBUILT_V2" }],
                },
              },
            ],
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["zeabur.list_projects"]?.({ limit: 5 }, credential);

    expect(result).toEqual({
      ok: true,
      output: {
        projects: [
          {
            id: "p1",
            name: "kd-ttc-dev",
            region: "tpe1",
            environments: [{ id: "e1", name: "production" }],
            services: [{ id: "s1", name: "kd-ttc", template: "PREBUILT_V2" }],
          },
        ],
      },
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(zeaburApiUrl);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-token");
    expect(graphqlCall(fetcher).variables).toEqual({ skip: undefined, limit: 5 });
  });

  it("throws when a 200 response carries a non-empty errors array", async () => {
    // GraphQL reports failures with HTTP 200, so status alone must not gate success.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: null, errors: [{ message: "project not found" }] })),
    );

    const result = await executors["zeabur.list_projects"]?.({}, credential);

    expect(result).toMatchObject({ ok: false, error: { message: "project not found" } });
  });

  it("reads the top-level message field Zeabur returns instead of errors[].message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            errors: [{ extensions: { code: "ERROR_INVALID_TOKEN" } }],
            message: "API Key in Authorization header is invalid.",
          },
          401,
        ),
      ),
    );

    const result = await executors["zeabur.list_projects"]?.({}, credential);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", message: "API Key in Authorization header is invalid." },
    });
  });
});

describe("zeabur credential validation", () => {
  it("builds a profile from the current user", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ data: { me: { _id: "u1", name: "Kedia Su", username: "howardsue319", email: "k@example.com" } } }),
    );

    const result = await credentialValidators.apiKey?.({ apiKey: "sk-token", values: {} }, { fetcher });

    expect(result).toMatchObject({
      profile: { accountId: "u1", displayName: "Kedia Su" },
      metadata: { username: "howardsue319", email: "k@example.com", apiBaseUrl: zeaburApiUrl },
    });
  });

  it("reports an invalid token as invalid input rather than an auth failure", async () => {
    // During validation the user is fixing the credential, so 401 must surface as "bad key", not "unauthorized".
    const fetcher = vi.fn(async () =>
      jsonResponse({ errors: [{ extensions: { code: "ERROR_INVALID_TOKEN" } }], message: "invalid key" }, 401),
    );

    await expect(credentialValidators.apiKey?.({ apiKey: "sk-bad", values: {} }, { fetcher })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("maskSecret", () => {
  it("reveals head and tail only for values long enough to stay unguessable", () => {
    expect(maskSecret("sk-abcdefghijkl3f2a")).toBe("sk-…3f2a");
  });

  it("fully masks short values", () => {
    expect(maskSecret("hunter2")).toBe("…");
    expect(maskSecret("12345678")).toBe("…");
  });
});

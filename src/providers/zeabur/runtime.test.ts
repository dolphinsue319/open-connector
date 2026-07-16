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

  it("keeps the extensions description that explains why an operation was refused", async () => {
    // Zeabur's errors[].message is a terse summary; the actionable reason lives in extensions.description.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: null,
          errors: [
            {
              message: "Failed to search runtime logs",
              extensions: { code: "PERMISSION_DENIED", description: "Advanced log search requires Pro or Team plan." },
            },
          ],
        }),
      ),
    );

    const result = await executors["zeabur.search_runtime_logs"]?.({ serviceId: "s1", query: "boom" }, credential);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "authorization_failed",
        message: "Failed to search runtime logs: Advanced log search requires Pro or Team plan.",
      },
    });
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

describe("zeabur.list_env_vars", () => {
  const variablesResponse = {
    data: {
      service: {
        variables: [
          { key: "JWT_SECRET", value: "super-secret-value-3f2a", exposed: false, readonly: false },
          { key: "PORT", value: "8080", exposed: true, readonly: true },
        ],
      },
    },
  };

  it("masks values by default so secrets stay out of the caller's context", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(variablesResponse)));

    const result = await executors["zeabur.list_env_vars"]?.({ serviceId: "s1", environmentId: "e1" }, credential);

    expect(result).toEqual({
      ok: true,
      output: {
        variables: [
          { key: "JWT_SECRET", valuePreview: "sup…3f2a", masked: true, exposed: false, readonly: false },
          { key: "PORT", valuePreview: "…", masked: true, exposed: true, readonly: true },
        ],
      },
    });
  });

  it("returns plaintext only when reveal is explicitly requested", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(variablesResponse)));

    const result = await executors["zeabur.list_env_vars"]?.(
      { serviceId: "s1", environmentId: "e1", reveal: true },
      credential,
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        variables: [
          { key: "JWT_SECRET", value: "super-secret-value-3f2a", masked: false },
          { key: "PORT", value: "8080", masked: false },
        ],
      },
    });
  });
});

describe("zeabur read actions", () => {
  it("passes the environment id through to the service status selection", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        data: { service: { _id: "s1", name: "kd-ttc", template: "PREBUILT_V2", dnsName: "kd-ttc", status: "RUNNING" } },
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["zeabur.get_service"]?.({ serviceId: "s1", environmentId: "e1" }, credential);

    expect(result).toMatchObject({ ok: true, output: { id: "s1", name: "kd-ttc", status: "RUNNING" } });
    expect(graphqlCall(fetcher).variables).toMatchObject({ id: "s1", environmentId: "e1" });
  });

  it("flattens the deployment connection edges", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: {
            deployments: {
              edges: [
                {
                  cursor: "c1",
                  node: { _id: "d1", status: "RUNNING", ref: "refs/heads/develop", commitMessage: "fix" },
                },
              ],
            },
          },
        }),
      ),
    );

    const result = await executors["zeabur.list_deployments"]?.(
      { serviceId: "s1", environmentId: "e1" },
      credential,
    );

    expect(result).toMatchObject({
      ok: true,
      output: { deployments: [{ id: "d1", status: "RUNNING", ref: "refs/heads/develop", cursor: "c1" }] },
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

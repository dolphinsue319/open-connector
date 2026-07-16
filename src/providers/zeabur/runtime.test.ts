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

function graphqlCall(
  fetcher: ReturnType<typeof vi.fn>,
  index = 0,
): { query: string; variables: Record<string, unknown> } {
  const init = fetcher.mock.calls[index]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
}

const credential = {
  getCredential: async (): Promise<ReturnType<typeof apiKeyCredential>> => apiKeyCredential("sk-token"),
};

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

  it("never carries the data payload into error details", async () => {
    // A GraphQL partial response returns data AND errors together. Echoing the envelope into error
    // details would hand back every plaintext env var and route around list_env_vars' masking.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: { service: { variables: [{ key: "JWT_SECRET", value: "super-secret-value-3f2a" }] } },
          errors: [{ message: "cannot resolve field" }],
        }),
      ),
    );

    const result = await executors["zeabur.list_env_vars"]?.({ serviceId: "s1", environmentId: "e1" }, credential);

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("super-secret-value-3f2a");
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(variablesResponse)),
    );

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

  it("returns revealed values byte-for-byte, including trailing newlines", async () => {
    // A PEM key ends in a newline. Trimming it hands back a value that no longer works where it was copied.
    const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { service: { variables: [{ key: "SSL_KEY", value: pem }] } } })),
    );

    const result = (await executors["zeabur.list_env_vars"]?.(
      { serviceId: "s1", environmentId: "e1", reveal: true },
      credential,
    )) as { output: { variables: Array<{ value: string }> } };

    expect(result.output.variables[0]?.value).toBe(pem);
  });

  it("returns plaintext only when reveal is explicitly requested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(variablesResponse)),
    );

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

    const result = await executors["zeabur.list_deployments"]?.({ serviceId: "s1", environmentId: "e1" }, credential);

    expect(result).toMatchObject({
      ok: true,
      output: { deployments: [{ id: "d1", status: "RUNNING", ref: "refs/heads/develop", cursor: "c1" }] },
    });
  });
});

describe("zeabur.set_env_var", () => {
  it("updates in place when the key already exists, touching only that key", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("ListEnvVarKeys")) {
        return jsonResponse({ data: { service: { variables: [{ key: "EXISTING" }, { key: "OTHER" }] } } });
      }
      return jsonResponse({
        data: { updateSingleEnvironmentVariable: [{ key: "EXISTING" }, { key: "OTHER" }] },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["zeabur.set_env_var"]?.(
      { serviceId: "s1", environmentId: "e1", key: "EXISTING", value: "v2" },
      credential,
    );

    expect(result).toEqual({ ok: true, output: { key: "EXISTING", created: false, variableCount: 2 } });
    // The existence check needs names only — selecting value would drag every secret over the wire.
    expect(graphqlCall(fetcher, 0).query).not.toContain("value");
    const mutation = graphqlCall(fetcher, 1);
    expect(mutation.query).toContain("updateSingleEnvironmentVariable");
    // The whole point of the per-key mutation: never send a full map that could replace the set.
    expect(mutation.query).not.toContain("updateEnvironmentVariable(");
    expect(mutation.variables).toEqual({
      serviceId: "s1",
      environmentId: "e1",
      oldKey: "EXISTING",
      newKey: "EXISTING",
      value: "v2",
    });
  });

  it("creates a new key when it does not exist yet and reports the resulting count", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("ListEnvVarKeys")) {
        // First call: existence check (1 var). Second call: post-create re-read (2 vars).
        const seen = fetcher.mock.calls.length > 2;
        return jsonResponse({
          data: { service: { variables: seen ? [{ key: "OTHER" }, { key: "NEW" }] : [{ key: "OTHER" }] } },
        });
      }
      return jsonResponse({ data: { createEnvironmentVariable: { key: "NEW" } } });
    });
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["zeabur.set_env_var"]?.(
      { serviceId: "s1", environmentId: "e1", key: "NEW", value: "v1" },
      credential,
    );

    expect(result).toEqual({ ok: true, output: { key: "NEW", created: true, variableCount: 2 } });
    expect(graphqlCall(fetcher, 1).query).toContain("createEnvironmentVariable");
  });
});

describe("zeabur.delete_env_var", () => {
  it("deletes one key and reports the variables that remain", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ data: { deleteSingleEnvironmentVariable: [{ key: "KEPT_A" }, { key: "KEPT_B" }] } }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["zeabur.delete_env_var"]?.(
      { serviceId: "s1", environmentId: "e1", key: "GONE" },
      credential,
    );

    expect(result).toEqual({ ok: true, output: { key: "GONE", deleted: true, variableCount: 2 } });
  });

  it("reports deleted:false when the key survives the mutation", async () => {
    // The mutation returns the surviving set; if the key is still in it, nothing was deleted.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ data: { deleteSingleEnvironmentVariable: [{ key: "STAYS" }, { key: "KEPT" }] } }),
      ),
    );

    const result = await executors["zeabur.delete_env_var"]?.(
      { serviceId: "s1", environmentId: "e1", key: "STAYS" },
      credential,
    );

    expect(result).toMatchObject({ ok: true, output: { key: "STAYS", deleted: false } });
  });
});

describe("zeabur deployment control", () => {
  it("restarts a service and reports the mutation result", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: { restartService: true } }));
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["zeabur.restart_service"]?.({ serviceId: "s1", environmentId: "e1" }, credential);

    expect(result).toEqual({ ok: true, output: { success: true } });
    expect(graphqlCall(fetcher).variables).toEqual({ serviceId: "s1", environmentId: "e1" });
  });

  it("rolls back a deployment by id", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: { rollbackDeployment: true } }));
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["zeabur.rollback_deployment"]?.({ deploymentId: "d1" }, credential);

    expect(result).toEqual({ ok: true, output: { success: true } });
  });
});

describe("maskSecret", () => {
  it("reveals head and tail only when they stay a minority of the value", () => {
    expect(maskSecret("sk_live_abcdefghijklmnop3f2a")).toBe("sk_…3f2a");
  });

  it("fully masks values too short for a preview to stay a minority", () => {
    // The preview is a fixed 7 characters, so anything under 21 would disclose a third or more.
    expect(maskSecret("hunter2")).toBe("…");
    expect(maskSecret("Tr0ub4dor3")).toBe("…");
    expect(maskSecret("development")).toBe("…");
    expect(maskSecret("a".repeat(20))).toBe("…");
  });

  it("never reveals more than a third of the value", () => {
    for (const length of [21, 24, 32, 64]) {
      const revealed = maskSecret("x".repeat(length)).replace("…", "").length;
      expect(revealed / length).toBeLessThanOrEqual(1 / 3);
    }
  });
});

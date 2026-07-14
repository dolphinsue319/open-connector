import { afterEach, describe, expect, it, vi } from "vitest";
import { apiKeyCredential } from "../provider-proxy-loader.test-helpers.ts";
import { credentialValidators, executors } from "./executors.ts";
import { buildRedmineApiUrl, normalizeRedmineBaseUrl } from "./runtime.ts";

const baseUrl = "https://tcredmine.turn2cloud.com/redmine";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeRedmineBaseUrl", () => {
  it("preserves an instance sub-path and strips the trailing slash", () => {
    expect(normalizeRedmineBaseUrl("https://tcredmine.turn2cloud.com/redmine/")).toBe(baseUrl);
  });

  it("returns the origin only when there is no sub-path", () => {
    expect(normalizeRedmineBaseUrl("https://redmine.example.com")).toBe("https://redmine.example.com");
  });

  it("rejects non-https base URLs", () => {
    expect(() => normalizeRedmineBaseUrl("http://redmine.example.com")).toThrow(/https/u);
  });

  it("rejects private network hosts", () => {
    expect(() => normalizeRedmineBaseUrl("https://192.168.1.10/redmine")).toThrow(/private|reserved/u);
  });

  it("rejects an empty base URL", () => {
    expect(() => normalizeRedmineBaseUrl("   ")).toThrow(/required/u);
  });
});

describe("buildRedmineApiUrl", () => {
  it("appends the endpoint under the instance sub-path with query params", () => {
    expect(buildRedmineApiUrl(baseUrl, "/issues.json", { limit: 10, status_id: "open" })).toBe(
      "https://tcredmine.turn2cloud.com/redmine/issues.json?limit=10&status_id=open",
    );
  });

  it("preserves nested endpoint paths", () => {
    expect(buildRedmineApiUrl(baseUrl, "/enumerations/issue_priorities.json")).toBe(
      "https://tcredmine.turn2cloud.com/redmine/enumerations/issue_priorities.json",
    );
  });
});

describe("redmine executors", () => {
  it("lists issues with the API key header and normalizes the envelope", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ issues: [{ id: 1, subject: "Test" }], total_count: 1, offset: 0, limit: 25 }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["redmine.list_issues"]?.(
      { statusId: "open", limit: 25 },
      { getCredential: async () => apiKeyCredential("secret_key", { baseUrl }) },
    );

    expect(result).toEqual({
      ok: true,
      output: {
        issues: [{ id: 1, subject: "Test" }],
        total_count: 1,
        offset: 0,
        limit: 25,
      },
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://tcredmine.turn2cloud.com/redmine/issues.json?status_id=open&limit=25");
    expect((init!.headers as Headers).get("X-Redmine-API-Key")).toBe("secret_key");
  });

  it("returns a synthetic result for the empty body of an issue update", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["redmine.update_issue"]?.(
      { id: 42, notes: "Working on it", statusId: 2 },
      { getCredential: async () => apiKeyCredential("secret_key", { baseUrl }) },
    );

    expect(result).toEqual({ ok: true, output: { ok: true, id: 42 } });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://tcredmine.turn2cloud.com/redmine/issues/42.json");
    expect(init!.method).toBe("PUT");
    expect(JSON.parse(init!.body as string)).toEqual({ issue: { status_id: 2, notes: "Working on it" } });
  });

  it("maps execution 401 responses to authorization failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => jsonResponse({ errors: ["Invalid API key"] }, 401)),
    );

    const result = await executors["redmine.get_current_user"]?.(
      {},
      { getCredential: async () => apiKeyCredential("bad_key", { baseUrl }) },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "authorization_failed",
        message: "Invalid API key",
      },
    });
  });
});

describe("redmine credential validation", () => {
  it("validates the API key and stores the normalized base URL", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({
          user: { id: 5, login: "kedia", firstname: "Kedia", lastname: "Su", mail: "kedia@example.com" },
        }),
    );

    const result = await credentialValidators.apiKey?.(
      { apiKey: "secret_key", values: { apiKey: "secret_key", baseUrl: "https://tcredmine.turn2cloud.com/redmine/" } },
      { fetcher },
    );

    expect(result).toEqual({
      profile: {
        accountId: "redmine:tcredmine.turn2cloud.com/redmine:5",
        displayName: "Kedia Su",
      },
      grantedScopes: [],
      metadata: {
        baseUrl,
        validationEndpoint: "/users/current.json",
        userId: "5",
        login: "kedia",
        email: "kedia@example.com",
      },
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://tcredmine.turn2cloud.com/redmine/users/current.json");
    expect((init!.headers as Headers).get("X-Redmine-API-Key")).toBe("secret_key");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

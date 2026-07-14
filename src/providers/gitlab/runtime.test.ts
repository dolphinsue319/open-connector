import { afterEach, describe, expect, it, vi } from "vitest";
import { apiKeyCredential } from "../provider-proxy-loader.test-helpers.ts";
import { buildGitlabApiUrl, credentialValidators, executors, normalizeGitlabBaseUrl } from "./executors.ts";

const selfHosted = "https://gl.thread.tw";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeGitlabBaseUrl", () => {
  it("defaults to gitlab.com when empty", () => {
    expect(normalizeGitlabBaseUrl("   ")).toBe("https://gitlab.com/api/v4");
    expect(normalizeGitlabBaseUrl(undefined)).toBe("https://gitlab.com/api/v4");
  });

  it("appends /api/v4 to a self-hosted host and strips a trailing slash", () => {
    expect(normalizeGitlabBaseUrl("https://gl.thread.tw/")).toBe("https://gl.thread.tw/api/v4");
  });

  it("preserves an instance sub-path", () => {
    expect(normalizeGitlabBaseUrl("https://example.com/gitlab")).toBe("https://example.com/gitlab/api/v4");
  });

  it("does not double an existing /api/v4 suffix", () => {
    expect(normalizeGitlabBaseUrl("https://gl.thread.tw/api/v4")).toBe("https://gl.thread.tw/api/v4");
  });

  it("rejects non-https base URLs", () => {
    expect(() => normalizeGitlabBaseUrl("http://gl.thread.tw")).toThrow(/https/u);
  });

  it("rejects private network hosts", () => {
    expect(() => normalizeGitlabBaseUrl("https://192.168.1.10")).toThrow(/private|reserved/u);
  });
});

describe("buildGitlabApiUrl", () => {
  it("joins the API base, path, and query params", () => {
    expect(buildGitlabApiUrl("https://gl.thread.tw/api/v4", "/projects", { search: "app", per_page: 10 })).toBe(
      "https://gl.thread.tw/api/v4/projects?search=app&per_page=10",
    );
  });
});

describe("gitlab executors base URL", () => {
  it("targets the connection's self-hosted base URL with the PRIVATE-TOKEN header", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ id: 7, username: "kedia", name: "Kedia" }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["gitlab.get_current_user"]?.(
      {},
      { getCredential: async () => apiKeyCredential("glpat-token", { baseUrl: selfHosted }) },
    );

    expect(result).toEqual({ ok: true, output: { id: 7, username: "kedia", name: "Kedia" } });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url.toString()).toBe("https://gl.thread.tw/api/v4/user");
    expect((init!.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat-token");
  });

  it("defaults to gitlab.com when no base URL is configured", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ id: 1, username: "u", name: "U" }),
    );
    vi.stubGlobal("fetch", fetcher);

    await executors["gitlab.get_current_user"]?.(
      {},
      { getCredential: async () => apiKeyCredential("glpat-token", {}) },
    );

    expect(fetcher.mock.calls[0]![0].toString()).toBe("https://gitlab.com/api/v4/user");
  });
});

describe("gitlab credential validation", () => {
  it("validates against the self-hosted instance and stores the resolved apiBaseUrl", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ id: 626, username: "kedia", name: "Kedia Su", web_url: "https://gl.thread.tw/kedia" }),
    );

    const result = await credentialValidators.apiKey?.(
      { apiKey: "glpat-token", values: { apiKey: "glpat-token", baseUrl: "https://gl.thread.tw/" } },
      { fetcher },
    );

    expect(result).toMatchObject({
      profile: { accountId: "gitlab:626", displayName: "Kedia Su" },
      metadata: { apiBaseUrl: "https://gl.thread.tw/api/v4", validationEndpoint: "/user", username: "kedia" },
    });

    expect(fetcher.mock.calls[0]![0].toString()).toBe("https://gl.thread.tw/api/v4/user");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

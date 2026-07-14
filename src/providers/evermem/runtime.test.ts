import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialValidators } from "./executors.ts";
import { buildEvermemApiUrl, normalizeEvermemBaseUrl } from "./runtime.ts";

const baseUrl = "https://evercore.incandgold.cc";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeEvermemBaseUrl", () => {
  it("returns the origin and strips a trailing slash", () => {
    expect(normalizeEvermemBaseUrl("https://evercore.incandgold.cc/")).toBe(baseUrl);
  });

  it("returns the origin only when there is no sub-path", () => {
    expect(normalizeEvermemBaseUrl("https://evercore.incandgold.cc")).toBe(baseUrl);
  });

  it("preserves an instance sub-path", () => {
    expect(normalizeEvermemBaseUrl("https://example.com/everos/")).toBe("https://example.com/everos");
  });

  it("rejects non-https base URLs", () => {
    expect(() => normalizeEvermemBaseUrl("http://evercore.incandgold.cc")).toThrow(/https/u);
  });

  it("rejects private network hosts", () => {
    expect(() => normalizeEvermemBaseUrl("https://192.168.1.10")).toThrow(/private|reserved/u);
  });

  it("rejects an empty base URL", () => {
    expect(() => normalizeEvermemBaseUrl("   ")).toThrow(/required/u);
  });
});

describe("buildEvermemApiUrl", () => {
  it("appends the endpoint path to the base URL", () => {
    expect(buildEvermemApiUrl(baseUrl, "/api/v1/memory/search")).toBe(
      "https://evercore.incandgold.cc/api/v1/memory/search",
    );
  });

  it("preserves an instance sub-path when appending the endpoint", () => {
    expect(buildEvermemApiUrl("https://example.com/everos", "/health")).toBe("https://example.com/everos/health");
  });

  it("appends query parameters and skips undefined values", () => {
    expect(
      buildEvermemApiUrl(baseUrl, "/api/v1/memory/search", { top_k: 10, method: "hybrid", missing: undefined }),
    ).toBe("https://evercore.incandgold.cc/api/v1/memory/search?top_k=10&method=hybrid");
  });
});

describe("evermem credential validation", () => {
  it("validates the bearer token against an authenticated API path and stores the normalized base URL", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ request_id: "abc123", data: { categories: [] } }),
    );

    const result = await credentialValidators.apiKey?.(
      { apiKey: "secret_token", values: { apiKey: "secret_token", baseUrl: "https://evercore.incandgold.cc/" } },
      { fetcher },
    );

    expect(result).toEqual({
      profile: {
        accountId: "evermem:evercore.incandgold.cc",
        displayName: "EverOS (evercore.incandgold.cc)",
      },
      grantedScopes: [],
      metadata: {
        baseUrl,
        validationEndpoint: "/api/v1/knowledge/categories",
      },
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://evercore.incandgold.cc/api/v1/knowledge/categories");
    expect((init!.headers as Headers).get("Authorization")).toBe("Bearer secret_token");
  });

  it("rejects an invalid bearer token", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ error: { code: "UNAUTHORIZED", message: "invalid token" } }, 401),
    );

    await expect(
      credentialValidators.apiKey?.({ apiKey: "bad", values: { apiKey: "bad", baseUrl } }, { fetcher }),
    ).rejects.toThrow(/invalid token/u);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

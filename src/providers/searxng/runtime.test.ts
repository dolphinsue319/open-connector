import { afterEach, describe, expect, it, vi } from "vitest";
import { customCredential } from "../provider-proxy-loader.test-helpers.ts";
import { credentialValidators, executors } from "./executors.ts";
import { buildSearxngUrl, defaultSearxngBaseUrl, normalizeSearxngBaseUrl } from "./runtime.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeSearxngBaseUrl", () => {
  it("defaults a blank value to the OrbStack host gateway", () => {
    expect(normalizeSearxngBaseUrl("   ")).toBe(defaultSearxngBaseUrl);
    expect(normalizeSearxngBaseUrl(undefined)).toBe(defaultSearxngBaseUrl);
  });

  it("keeps http and the .internal host and strips a trailing slash (SSRF guard intentionally not applied)", () => {
    expect(normalizeSearxngBaseUrl("http://host.docker.internal:8080/")).toBe("http://host.docker.internal:8080");
  });

  it("allows a private IP target", () => {
    expect(normalizeSearxngBaseUrl("http://192.168.1.10:8080")).toBe("http://192.168.1.10:8080");
  });

  it("preserves an https tunnel target and an instance sub-path", () => {
    expect(normalizeSearxngBaseUrl("https://searxng.example.com/searx/")).toBe("https://searxng.example.com/searx");
  });

  it("rejects a non-http(s) protocol", () => {
    expect(() => normalizeSearxngBaseUrl("ftp://host.docker.internal")).toThrow(/http or https/u);
  });

  it("rejects a value that is not a URL", () => {
    expect(() => normalizeSearxngBaseUrl("not a url")).toThrow(/valid URL/u);
  });
});

describe("buildSearxngUrl", () => {
  it("appends the endpoint path to the base URL when there is no query", () => {
    expect(buildSearxngUrl("http://host.docker.internal:8080", "/config")).toBe(
      "http://host.docker.internal:8080/config",
    );
  });

  it("serializes query parameters onto the URL", () => {
    const url = new URL(buildSearxngUrl("http://host.docker.internal:8080", "/search", { q: "cats", format: "json" }));
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("cats");
    expect(url.searchParams.get("format")).toBe("json");
  });
});

describe("searxng credential validation", () => {
  it("hits /config with NO auth header and stores the default base URL", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ engines: [], categories: ["general"] }),
    );

    const result = await credentialValidators.customCredential?.({ values: {} }, { fetcher });

    expect(result).toEqual({
      profile: {
        accountId: "searxng:host.docker.internal:8080",
        displayName: "SearXNG (host.docker.internal:8080)",
      },
      grantedScopes: [],
      metadata: {
        baseUrl: "http://host.docker.internal:8080",
        validationEndpoint: "/config",
      },
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://host.docker.internal:8080/config");
    expect((init!.headers as Headers).get("authorization")).toBeNull();
  });

  it("validates against a configured base URL", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ engines: [], categories: ["general"] }),
    );

    const result = await credentialValidators.customCredential?.(
      { values: { baseUrl: "http://192.168.1.50:8080" } },
      { fetcher },
    );

    expect(result).toMatchObject({ metadata: { baseUrl: "http://192.168.1.50:8080" } });
    expect(fetcher.mock.calls[0]![0]).toBe("http://192.168.1.50:8080/config");
  });

  it("rejects a 200 that is not a SearXNG response", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse({ message: "hello" }),
    );

    await expect(credentialValidators.customCredential?.({ values: {} }, { fetcher })).rejects.toThrow(
      /unexpected response/u,
    );
  });
});

describe("searxng.config", () => {
  it("GETs /config from the local base URL with no auth header", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ engines: [{ name: "google" }], categories: ["general"], instance_name: "KD SearXNG" }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["searxng.config"]?.({}, { getCredential: async () => customCredential({}) });

    expect(result).toMatchObject({ ok: true, output: { instance_name: "KD SearXNG" } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://host.docker.internal:8080/config");
    expect(init!.method ?? "GET").toBe("GET");
    expect((init!.headers as Headers).get("authorization")).toBeNull();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

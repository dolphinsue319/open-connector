import { afterEach, describe, expect, it, vi } from "vitest";
import { customCredential } from "../provider-proxy-loader.test-helpers.ts";
import { credentialValidators, executors } from "./executors.ts";
import { buildFirecrawlLocalApiUrl, defaultFirecrawlLocalBaseUrl, normalizeFirecrawlLocalBaseUrl } from "./runtime.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeFirecrawlLocalBaseUrl", () => {
  it("defaults a blank value to the OrbStack host gateway", () => {
    expect(normalizeFirecrawlLocalBaseUrl("   ")).toBe(defaultFirecrawlLocalBaseUrl);
    expect(normalizeFirecrawlLocalBaseUrl(undefined)).toBe(defaultFirecrawlLocalBaseUrl);
  });

  it("keeps http and the .internal host and strips a trailing slash (SSRF guard intentionally not applied)", () => {
    expect(normalizeFirecrawlLocalBaseUrl("http://host.docker.internal:3002/")).toBe(
      "http://host.docker.internal:3002",
    );
  });

  it("allows a private IP target", () => {
    expect(normalizeFirecrawlLocalBaseUrl("http://192.168.1.10:3002")).toBe("http://192.168.1.10:3002");
  });

  it("preserves an https tunnel target and an instance sub-path", () => {
    expect(normalizeFirecrawlLocalBaseUrl("https://firecrawl.example.com/fc/")).toBe(
      "https://firecrawl.example.com/fc",
    );
  });

  it("rejects a non-http(s) protocol", () => {
    expect(() => normalizeFirecrawlLocalBaseUrl("ftp://host.docker.internal")).toThrow(/http or https/u);
  });

  it("rejects a value that is not a URL", () => {
    expect(() => normalizeFirecrawlLocalBaseUrl("not a url")).toThrow(/valid URL/u);
  });
});

describe("buildFirecrawlLocalApiUrl", () => {
  it("appends the endpoint path to the base URL", () => {
    expect(buildFirecrawlLocalApiUrl("http://host.docker.internal:3002", "/v2/scrape")).toBe(
      "http://host.docker.internal:3002/v2/scrape",
    );
  });
});

describe("firecrawl_local credential validation", () => {
  it("hits /v2/crawl/active with NO auth header and stores the default base URL", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ success: true, crawls: [] }),
    );

    const result = await credentialValidators.customCredential?.({ values: {} }, { fetcher });

    expect(result).toEqual({
      profile: {
        accountId: "firecrawl_local:host.docker.internal:3002",
        displayName: "Firecrawl (host.docker.internal:3002)",
      },
      grantedScopes: [],
      metadata: {
        baseUrl: "http://host.docker.internal:3002",
        validationEndpoint: "/v2/crawl/active",
      },
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://host.docker.internal:3002/v2/crawl/active");
    expect((init!.headers as Headers).get("authorization")).toBeNull();
  });

  it("validates against a configured base URL", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ success: true, crawls: [] }),
    );

    const result = await credentialValidators.customCredential?.(
      { values: { baseUrl: "http://192.168.1.50:3002" } },
      { fetcher },
    );

    expect(result).toMatchObject({ metadata: { baseUrl: "http://192.168.1.50:3002" } });
    expect(fetcher.mock.calls[0]![0]).toBe("http://192.168.1.50:3002/v2/crawl/active");
  });

  it("rejects a 200 that is not a Firecrawl response", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse({ message: "hello" }),
    );

    await expect(credentialValidators.customCredential?.({ values: {} }, { fetcher })).rejects.toThrow(
      /unexpected response/u,
    );
  });
});

describe("firecrawl_local.crawl_list_active", () => {
  it("GETs the active crawls from the local base URL with no auth header", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ success: true, crawls: [{ id: "c1" }] }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["firecrawl_local.crawl_list_active"]?.(
      {},
      { getCredential: async () => customCredential({}) },
    );

    expect(result).toEqual({ ok: true, output: { success: true, crawls: [{ id: "c1" }] } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://host.docker.internal:3002/v2/crawl/active");
    expect(init!.method ?? "GET").toBe("GET");
    expect((init!.headers as Headers).get("authorization")).toBeNull();
  });
});

describe("firecrawl_local scrape / search / map", () => {
  it("POSTs scrape to the local base URL with no auth header and forwards the input body", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ success: true, data: { markdown: "# hi" } }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["firecrawl_local.scrape"]?.(
      { url: "https://example.com", formats: ["markdown"], onlyMainContent: true },
      { getCredential: async () => customCredential({}) },
    );

    expect(result).toEqual({ ok: true, output: { success: true, data: { markdown: "# hi" } } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://host.docker.internal:3002/v2/scrape");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Headers).get("authorization")).toBeNull();
    expect((init!.headers as Headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init!.body as string)).toEqual({
      url: "https://example.com",
      formats: ["markdown"],
      onlyMainContent: true,
    });
  });

  it("POSTs search and folds top-level formats into scrapeOptions, honoring a configured baseUrl", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ success: true, data: [{ url: "https://a" }] }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["firecrawl_local.search"]?.(
      { query: "claude", limit: 3, formats: ["markdown"] },
      { getCredential: async () => customCredential({ baseUrl: "http://192.168.1.50:3002/" }) },
    );

    expect(result).toEqual({ ok: true, output: { success: true, data: [{ url: "https://a" }] } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://192.168.1.50:3002/v2/search");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      query: "claude",
      limit: 3,
      scrapeOptions: { formats: ["markdown"] },
    });
  });

  it("POSTs map with the input body", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ success: true, links: ["https://a", "https://b"] }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["firecrawl_local.map"]?.(
      { url: "https://example.com", limit: 100 },
      { getCredential: async () => customCredential({}) },
    );

    expect(result).toEqual({ ok: true, output: { success: true, links: ["https://a", "https://b"] } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://host.docker.internal:3002/v2/map");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ url: "https://example.com", limit: 100 });
  });
});

describe("firecrawl_local crawl / batch scrape jobs", () => {
  it("starts a crawl via POST with a nested scrapeOptions body", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ success: true, id: "job-1", url: "http://host.docker.internal:3002/v2/crawl/job-1" }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["firecrawl_local.crawl"]?.(
      { url: "https://example.com", limit: 20, scrapeOptions: { formats: ["markdown"] } },
      { getCredential: async () => customCredential({}) },
    );

    expect(result).toMatchObject({ ok: true, output: { success: true, id: "job-1" } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://host.docker.internal:3002/v2/crawl");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Headers).get("authorization")).toBeNull();
    expect(JSON.parse(init!.body as string)).toEqual({
      url: "https://example.com",
      limit: 20,
      scrapeOptions: { formats: ["markdown"] },
    });
  });

  it("gets a crawl job status via GET by id", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ success: true, status: "completed", total: 1, completed: 1, data: [{ markdown: "x" }] }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["firecrawl_local.crawl_get"]?.(
      { id: "job-1" },
      { getCredential: async () => customCredential({}) },
    );

    expect(result).toMatchObject({ ok: true, output: { status: "completed" } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://host.docker.internal:3002/v2/crawl/job-1");
    expect(init!.method ?? "GET").toBe("GET");
    expect((init!.headers as Headers).get("authorization")).toBeNull();
  });

  it("cancels a crawl job via DELETE by id", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ success: true, status: "cancelled" }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["firecrawl_local.crawl_cancel"]?.(
      { id: "job-1" },
      { getCredential: async () => customCredential({}) },
    );

    expect(result).toMatchObject({ ok: true, output: { status: "cancelled" } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://host.docker.internal:3002/v2/crawl/job-1");
    expect(init!.method).toBe("DELETE");
  });

  it("starts a batch scrape via POST and gets its status via GET by id", async () => {
    const startFetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ success: true, id: "batch-1" }),
    );
    vi.stubGlobal("fetch", startFetcher);

    const start = await executors["firecrawl_local.batch_scrape"]?.(
      { urls: ["https://a", "https://b"], formats: ["markdown"] },
      { getCredential: async () => customCredential({}) },
    );
    expect(start).toMatchObject({ ok: true, output: { id: "batch-1" } });
    const [startUrl, startInit] = startFetcher.mock.calls[0]!;
    expect(startUrl).toBe("http://host.docker.internal:3002/v2/batch/scrape");
    expect(startInit!.method).toBe("POST");
    expect(JSON.parse(startInit!.body as string)).toEqual({ urls: ["https://a", "https://b"], formats: ["markdown"] });

    const getFetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ success: true, status: "completed", total: 2, completed: 2, data: [] }),
    );
    vi.stubGlobal("fetch", getFetcher);

    const status = await executors["firecrawl_local.batch_scrape_get"]?.(
      { id: "batch-1" },
      { getCredential: async () => customCredential({}) },
    );
    expect(status).toMatchObject({ ok: true, output: { status: "completed" } });
    expect(getFetcher.mock.calls[0]![0]).toBe("http://host.docker.internal:3002/v2/batch/scrape/batch-1");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

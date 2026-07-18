import type { TransitFileWriter } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { customCredential } from "../provider-proxy-loader.test-helpers.ts";
import { credentialValidators, executors } from "./executors.ts";
import { defaultOpenscadBaseUrl, normalizeOpenscadBaseUrl, resolveOpenscadBaseUrl } from "./runtime.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonFetcher(body: unknown, status = 200): ReturnType<typeof vi.fn<Fetcher>> {
  return vi.fn<Fetcher>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

function bytesFetcher(bytes: Uint8Array, contentType: string, status = 200): ReturnType<typeof vi.fn<Fetcher>> {
  // A string body is enough: the runtime reads content-type from headers and the
  // output size from the transit store, not from the raw bytes.
  const body = String.fromCharCode(...bytes);
  return vi.fn<Fetcher>(async () => new Response(body, { status, headers: { "content-type": contentType } }));
}

function fakeTransitFiles(): TransitFileWriter & { create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (file: File) => ({
    fileId: "file_1",
    downloadUrl: "http://transit.local/files/file_1",
    sizeBytes: 4242,
    name: file.name,
    mimeType: file.type,
  }));
  return {
    maxBytes: 50_000_000,
    create,
    read: vi.fn(),
    delete: vi.fn(),
  } as unknown as TransitFileWriter & { create: ReturnType<typeof vi.fn> };
}

describe("normalizeOpenscadBaseUrl", () => {
  it("defaults a blank value to the OrbStack host gateway", () => {
    expect(normalizeOpenscadBaseUrl("   ")).toBe(defaultOpenscadBaseUrl);
    expect(normalizeOpenscadBaseUrl(undefined)).toBe(defaultOpenscadBaseUrl);
  });

  it("keeps http and strips a trailing slash", () => {
    expect(normalizeOpenscadBaseUrl("http://host.docker.internal:8910/")).toBe("http://host.docker.internal:8910");
  });

  it("rejects a non-http(s) protocol and a non-URL", () => {
    expect(() => normalizeOpenscadBaseUrl("ftp://host")).toThrow(/http or https/u);
    expect(() => normalizeOpenscadBaseUrl("not a url")).toThrow(/valid URL/u);
  });
});

describe("resolveOpenscadBaseUrl", () => {
  it("prefers metadata over values and falls back to the default", () => {
    expect(resolveOpenscadBaseUrl({ values: { baseUrl: "http://a:1" }, metadata: { baseUrl: "http://b:2" } })).toBe(
      "http://b:2",
    );
    expect(resolveOpenscadBaseUrl({ values: {}, metadata: {} })).toBe(defaultOpenscadBaseUrl);
  });
});

describe("openscad credential validation", () => {
  it("hits /health and stores the default base URL + version", async () => {
    const fetcher = jsonFetcher({ ok: true, version: "OpenSCAD version 2021.01" });

    const result = await credentialValidators.customCredential?.({ values: {} }, { fetcher });

    expect(result).toEqual({
      profile: {
        accountId: "openscad:host.docker.internal:8910",
        displayName: "OpenSCAD (host.docker.internal:8910)",
      },
      grantedScopes: [],
      metadata: { baseUrl: "http://host.docker.internal:8910", version: "OpenSCAD version 2021.01" },
    });
    expect(fetcher.mock.calls[0]![0]).toBe("http://host.docker.internal:8910/health");
  });

  it("rejects a health response without ok:true", async () => {
    const fetcher = jsonFetcher({ status: "up" });
    await expect(credentialValidators.customCredential?.({ values: {} }, { fetcher })).rejects.toThrow(
      /unexpected response/u,
    );
  });
});

describe("openscad.info", () => {
  it("GETs /health from the base URL", async () => {
    const fetcher = jsonFetcher({ ok: true, version: "OpenSCAD version 2021.01" });
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["openscad.info"]?.({}, { getCredential: async () => customCredential({}) });

    expect(result).toMatchObject({ ok: true, output: { ok: true, version: "OpenSCAD version 2021.01" } });
    expect(fetcher.mock.calls[0]![0]).toBe("http://host.docker.internal:8910/health");
  });
});

describe("openscad.render_model", () => {
  it("POSTs /render and wraps the bytes into a transit file", async () => {
    const fetcher = bytesFetcher(new Uint8Array([1, 2, 3, 4]), "model/stl");
    vi.stubGlobal("fetch", fetcher);
    const transitFiles = fakeTransitFiles();

    const result = await executors["openscad.render_model"]?.(
      { source: "cube(10);", params: { h: 3 } },
      { getCredential: async () => customCredential({}), transitFiles },
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        format: "stl",
        file: {
          name: "openscad.stl",
          mimetype: "model/stl",
          downloadUrl: "http://transit.local/files/file_1",
          fileId: "file_1",
          sizeBytes: 4242,
        },
      },
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://host.docker.internal:8910/render");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ source: "cube(10);", format: "stl", params: { h: 3 } });
    expect(transitFiles.create).toHaveBeenCalledOnce();
  });

  it("fails without transit storage", async () => {
    const fetcher = bytesFetcher(new Uint8Array([1]), "model/stl");
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["openscad.render_model"]?.(
      { source: "cube(10);" },
      { getCredential: async () => customCredential({}) },
    );

    expect(result).toMatchObject({ ok: false });
  });

  it("maps a 400 render error to a failed result", async () => {
    const fetcher = jsonFetcher({ error: "Parser error" }, 400);
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["openscad.render_model"]?.(
      { source: "cube(" },
      { getCredential: async () => customCredential({}), transitFiles: fakeTransitFiles() },
    );

    expect(result).toMatchObject({ ok: false });
  });
});

describe("openscad.render_preview", () => {
  it("POSTs /render with png + image options and returns a file", async () => {
    const fetcher = bytesFetcher(new Uint8Array([137, 80, 78, 71]), "image/png");
    vi.stubGlobal("fetch", fetcher);
    const transitFiles = fakeTransitFiles();

    const result = await executors["openscad.render_preview"]?.(
      {
        source: "cube(10);",
        imgsize: "1024,768",
        colorscheme: "Sunset",
        projection: "orthogonal",
        filename: "my model",
      },
      { getCredential: async () => customCredential({}), transitFiles },
    );

    expect(result).toMatchObject({
      ok: true,
      output: { file: { name: "my_model.png", mimetype: "image/png" } },
    });
    // preview output has no top-level `format`
    expect((result as { output: Record<string, unknown> }).output.format).toBeUndefined();

    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      source: "cube(10);",
      format: "png",
      imgsize: "1024,768",
      colorscheme: "Sunset",
      projection: "orthogonal",
    });
  });
});

describe("openscad.render_2d", () => {
  it("POSTs /render with the requested vector format", async () => {
    const fetcher = bytesFetcher(new Uint8Array([60, 115, 118, 103]), "image/svg+xml");
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["openscad.render_2d"]?.(
      { source: "square([20,10]);", format: "svg" },
      { getCredential: async () => customCredential({}), transitFiles: fakeTransitFiles() },
    );

    expect(result).toMatchObject({ ok: true, output: { format: "svg", file: { name: "openscad.svg" } } });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      source: "square([20,10]);",
      format: "svg",
    });
  });
});

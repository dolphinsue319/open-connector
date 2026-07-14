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

describe("gitlab issue workflow actions", () => {
  const cred = async () => apiKeyCredential("glpat-token", { baseUrl: "https://gl.thread.tw" });

  it("updates an issue via PUT with mapped fields", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ id: 1, iid: 12, title: "New", state: "closed" }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["gitlab.update_project_issue"]?.(
      { projectId: "42", issueIid: 12, title: "New", stateEvent: "close", addLabels: "bug" },
      { getCredential: cred },
    );

    expect(result).toMatchObject({ ok: true, output: { iid: 12, state: "closed" } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url.toString()).toBe("https://gl.thread.tw/api/v4/projects/42/issues/12");
    expect(init!.method).toBe("PUT");
    expect(JSON.parse(init!.body as string)).toEqual({ title: "New", add_labels: "bug", state_event: "close" });
  });

  it("creates an issue note via POST", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ id: 99, body: "Hello", system: false, noteable_iid: 12 }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["gitlab.create_issue_note"]?.(
      { projectId: "42", issueIid: 12, body: "Hello" },
      { getCredential: cred },
    );

    expect(result).toMatchObject({ ok: true, output: { id: 99, body: "Hello" } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url.toString()).toBe("https://gl.thread.tw/api/v4/projects/42/issues/12/notes");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ body: "Hello" });
  });

  it("lists issue notes with pagination parsed from headers", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify([{ id: 1, body: "a" }]), {
          status: 200,
          headers: { "content-type": "application/json", "x-total": "1", "x-next-page": "" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["gitlab.list_issue_notes"]?.(
      { projectId: "42", issueIid: 12, sort: "asc", perPage: 20 },
      { getCredential: cred },
    );

    expect(result).toEqual({ ok: true, output: { notes: [{ id: 1, body: "a" }], total: 1, nextPage: null } });
    expect(fetcher.mock.calls[0]![0].toString()).toBe(
      "https://gl.thread.tw/api/v4/projects/42/issues/12/notes?sort=asc&per_page=20",
    );
  });

  it("rejects a missing issueIid", async () => {
    const result = await executors["gitlab.create_issue_note"]?.(
      { projectId: "42", body: "Hello" },
      { getCredential: cred },
    );
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("issueIid") } });
  });

  it("rejects a whitespace-only note body", async () => {
    const result = await executors["gitlab.create_issue_note"]?.(
      { projectId: "42", issueIid: 12, body: "   " },
      { getCredential: cred },
    );
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("body") } });
  });

  it("rejects an issueIid of 0", async () => {
    const result = await executors["gitlab.update_project_issue"]?.(
      { projectId: "42", issueIid: 0, title: "x" },
      { getCredential: cred },
    );
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("issueIid") } });
  });
});

describe("gitlab repository read actions — commits + branches", () => {
  const cred = async () => apiKeyCredential("glpat-token", { baseUrl: "https://gl.thread.tw" });

  it("lists commits with mapped query params and header pagination", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify([{ id: "abc123def", short_id: "abc123", title: "Fix bug" }]), {
          status: 200,
          headers: { "content-type": "application/json", "x-total": "42", "x-next-page": "2" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["gitlab.list_commits"]?.(
      { projectId: "30", refName: "main", withStats: true, perPage: 3 },
      { getCredential: cred },
    );

    expect(result).toEqual({
      ok: true,
      output: { commits: [{ id: "abc123def", short_id: "abc123", title: "Fix bug" }], total: 42, nextPage: 2 },
    });
    expect(fetcher.mock.calls[0]![0].toString()).toBe(
      "https://gl.thread.tw/api/v4/projects/30/repository/commits?ref_name=main&with_stats=true&per_page=3",
    );
  });

  it("gets a single commit by sha", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ id: "abc123def", short_id: "abc123", title: "Fix bug", message: "Fix bug\n" }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["gitlab.get_commit"]?.(
      { projectId: "30", sha: "abc123def" },
      { getCredential: cred },
    );

    expect(result).toMatchObject({ ok: true, output: { id: "abc123def", short_id: "abc123" } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url.toString()).toBe("https://gl.thread.tw/api/v4/projects/30/repository/commits/abc123def");
    expect(init!.method).toBe("GET");
  });

  it("rejects get_commit without a sha", async () => {
    const result = await executors["gitlab.get_commit"]?.({ projectId: "30" }, { getCredential: cred });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("sha") } });
  });

  it("lists branches with header pagination", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify([{ name: "main", default: true, protected: true }]), {
          status: 200,
          headers: { "content-type": "application/json", "x-total": "1", "x-next-page": "" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["gitlab.list_branches"]?.(
      { projectId: "30", search: "main", perPage: 5 },
      { getCredential: cred },
    );

    expect(result).toEqual({
      ok: true,
      output: { branches: [{ name: "main", default: true, protected: true }], total: 1, nextPage: null },
    });
    expect(fetcher.mock.calls[0]![0].toString()).toBe(
      "https://gl.thread.tw/api/v4/projects/30/repository/branches?search=main&per_page=5",
    );
  });
});

describe("gitlab repository read actions — files", () => {
  const cred = async () => apiKeyCredential("glpat-token", { baseUrl: "https://gl.thread.tw" });

  it("lists the repository tree with query params and header pagination", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify([{ id: "a1", name: "src", type: "tree", path: "src", mode: "040000" }]), {
          status: 200,
          headers: { "content-type": "application/json", "x-total": "1", "x-next-page": "" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["gitlab.list_repository_tree"]?.(
      { projectId: "30", path: "src", ref: "main", recursive: true, perPage: 10 },
      { getCredential: cred },
    );

    expect(result).toEqual({
      ok: true,
      output: {
        tree: [{ id: "a1", name: "src", type: "tree", path: "src", mode: "040000" }],
        total: 1,
        nextPage: null,
      },
    });
    expect(fetcher.mock.calls[0]![0].toString()).toBe(
      "https://gl.thread.tw/api/v4/projects/30/repository/tree?path=src&ref=main&recursive=true&per_page=10",
    );
  });

  it("gets a file, url-encodes the path, and decodes base64 content", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({
          file_name: "b.swift",
          file_path: "a/b.swift",
          size: 5,
          encoding: "base64",
          content: "aGVsbG8=",
          ref: "main",
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["gitlab.get_file"]?.(
      { projectId: "30", filePath: "a/b.swift", ref: "main" },
      { getCredential: cred },
    );

    expect(result).toMatchObject({
      ok: true,
      output: { file_path: "a/b.swift", encoding: "base64", content: "aGVsbG8=", content_decoded: "hello" },
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url.toString()).toBe("https://gl.thread.tw/api/v4/projects/30/repository/files/a%2Fb.swift?ref=main");
    expect(init!.method).toBe("GET");
  });

  it("rejects get_file without a ref", async () => {
    const result = await executors["gitlab.get_file"]?.(
      { projectId: "30", filePath: "a/b.swift" },
      { getCredential: cred },
    );
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("ref") } });
  });

  it("rejects get_file without a filePath", async () => {
    const result = await executors["gitlab.get_file"]?.({ projectId: "30", ref: "main" }, { getCredential: cred });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("filePath") } });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

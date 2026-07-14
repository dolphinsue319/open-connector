import { afterEach, describe, expect, it, vi } from "vitest";
import { apiKeyCredential } from "../provider-proxy-loader.test-helpers.ts";
import { credentialValidators, executors } from "./executors.ts";
import { buildEvermemApiUrl, normalizeEvermemBaseUrl } from "./runtime.ts";

const baseUrl = "https://evercore.incandgold.cc";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  it("rejects a 200 that is not an EverOS envelope", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse({ ok: true }),
    );

    await expect(
      credentialValidators.apiKey?.({ apiKey: "t", values: { apiKey: "t", baseUrl } }, { fetcher }),
    ).rejects.toThrow(/unexpected response/u);
  });
});

describe("evermem add_memory / flush_memory", () => {
  it("posts a message with default scope and auto-flushes when not extracted", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith("/api/v1/memory/add")) {
        return jsonResponse({ request_id: "r1", data: { message_count: 1, status: "accumulated" } });
      }
      return jsonResponse({ request_id: "r2", data: { status: "extracted" } });
    });
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.add_memory"]?.(
      { content: "kedia likes tea", timestamp: 1752480000000 },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toEqual({
      ok: true,
      output: { message_count: 1, status: "accumulated", flush_status: "extracted" },
    });

    const [addUrl, addInit] = fetcher.mock.calls[0]!;
    expect(addUrl).toBe("https://evercore.incandgold.cc/api/v1/memory/add");
    expect(addInit!.method).toBe("POST");
    expect((addInit!.headers as Headers).get("Authorization")).toBe("Bearer secret");
    expect(JSON.parse(addInit!.body as string)).toEqual({
      session_id: "mcp-global",
      app_id: "evermem",
      project_id: "global",
      messages: [{ sender_id: "kedia", role: "user", timestamp: 1752480000000, content: "kedia likes tea" }],
    });

    const [flushUrl, flushInit] = fetcher.mock.calls[1]!;
    expect(flushUrl).toBe("https://evercore.incandgold.cc/api/v1/memory/flush");
    expect(JSON.parse(flushInit!.body as string)).toEqual({
      session_id: "mcp-global",
      app_id: "evermem",
      project_id: "global",
    });
  });

  it("skips the flush when the add already extracted", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ request_id: "r", data: { message_count: 1, status: "extracted" } }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.add_memory"]?.(
      { content: "x", timestamp: 1 },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toEqual({ ok: true, output: { message_count: 1, status: "extracted" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("honors scope overrides, defaults the timestamp, and skips flush when autoFlush is false", async () => {
    const now = 1752480000001;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ request_id: "r", data: { message_count: 1, status: "accumulated" } }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.add_memory"]?.(
      {
        content: "hi",
        autoFlush: false,
        sessionId: "s1",
        userId: "bob",
        appId: "app1",
        projectId: "proj1",
        role: "assistant",
        senderName: "Bob",
      },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toEqual({ ok: true, output: { message_count: 1, status: "accumulated" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      session_id: "s1",
      app_id: "app1",
      project_id: "proj1",
      messages: [{ sender_id: "bob", sender_name: "Bob", role: "assistant", timestamp: now, content: "hi" }],
    });
  });

  it("returns flush_status pending when the flush exceeds its timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith("/api/v1/memory/add")) {
        return Promise.resolve(jsonResponse({ request_id: "r", data: { message_count: 1, status: "accumulated" } }));
      }
      // Flush hangs until its own timeout aborts the request.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const pending = executors["evermem.add_memory"]?.(
      { content: "x", timestamp: 1 },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(result).toEqual({
      ok: true,
      output: { message_count: 1, status: "accumulated", flush_status: "pending" },
    });
  });

  it("degrades to flush_status pending when the flush fails after a successful add", async () => {
    // The add already persisted the message, so a failed flush must not fail the
    // whole call (a retry would double-write) — it degrades to pending.
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith("/api/v1/memory/add")) {
        return jsonResponse({ request_id: "r", data: { message_count: 1, status: "accumulated" } });
      }
      return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "boom" } }, 500);
    });
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.add_memory"]?.(
      { content: "x", timestamp: 1 },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toEqual({
      ok: true,
      output: { message_count: 1, status: "accumulated", flush_status: "pending" },
    });
  });

  it("fails the call when the add itself errors, without attempting a flush", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ error: { code: "INVALID_INPUT", message: "bad message" } }, 422),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.add_memory"]?.(
      { content: "x", timestamp: 1 },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing content field without calling the API", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse({}),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.add_memory"]?.(
      {},
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("flush_memory posts the scope and returns the flush status", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ request_id: "r", data: { status: "no_extraction" } }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.flush_memory"]?.(
      { sessionId: "s2" },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toEqual({ ok: true, output: { status: "no_extraction" } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://evercore.incandgold.cc/api/v1/memory/flush");
    expect(JSON.parse(init!.body as string)).toEqual({ session_id: "s2", app_id: "evermem", project_id: "global" });
  });
});

describe("evermem search_memory / list_memories", () => {
  const searchEnvelope = {
    request_id: "r",
    data: {
      episodes: [{ id: "e1", summary: "tea" }],
      profiles: [],
      agent_cases: [],
      agent_skills: [],
      unprocessed_messages: [],
    },
  };
  const listEnvelope = {
    request_id: "r",
    data: { episodes: [], profiles: [], agent_cases: [], agent_skills: [], total_count: 0, count: 0 },
  };

  it("search_memory posts the default owner, method and topK and returns the data envelope", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse(searchEnvelope),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.search_memory"]?.(
      { query: "tea" },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toEqual({ ok: true, output: searchEnvelope.data });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://evercore.incandgold.cc/api/v1/memory/search");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Headers).get("Authorization")).toBe("Bearer secret");
    expect(JSON.parse(init!.body as string)).toEqual({
      user_id: "kedia",
      app_id: "evermem",
      project_id: "global",
      query: "tea",
      method: "hybrid",
      top_k: 10,
      include_profile: true,
    });
  });

  it("search_memory sends agent_id instead of user_id and defaults include_profile false for an agent", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse(searchEnvelope),
    );
    vi.stubGlobal("fetch", fetcher);

    await executors["evermem.search_memory"]?.(
      { query: "x", agentId: "agent-7", method: "keyword", topK: 5 },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      agent_id: "agent-7",
      app_id: "evermem",
      project_id: "global",
      query: "x",
      method: "keyword",
      top_k: 5,
      include_profile: false,
    });
  });

  it("search_memory rejects when both userId and agentId are supplied", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse(searchEnvelope),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.search_memory"]?.(
      { query: "x", userId: "kedia", agentId: "a1" },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("search_memory rejects topK of 0 but forwards -1", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse(searchEnvelope),
    );
    vi.stubGlobal("fetch", fetcher);

    const zero = await executors["evermem.search_memory"]?.(
      { query: "x", topK: 0 },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );
    expect(zero).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetcher).not.toHaveBeenCalled();

    await executors["evermem.search_memory"]?.(
      { query: "x", topK: -1 },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).top_k).toBe(-1);
  });

  it("list_memories rejects a memoryType that does not match the owner", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse(listEnvelope),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.list_memories"]?.(
      { userId: "kedia", memoryType: "agent_case" },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("search_memory rejects a missing query without calling the API", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse({}),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.search_memory"]?.(
      {},
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("list_memories posts the default pagination and sort and returns the data envelope", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse(listEnvelope),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.list_memories"]?.(
      {},
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toEqual({ ok: true, output: listEnvelope.data });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://evercore.incandgold.cc/api/v1/memory/get");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      user_id: "kedia",
      app_id: "evermem",
      project_id: "global",
      memory_type: "episode",
      page: 1,
      page_size: 20,
      sort_by: "timestamp",
      sort_order: "desc",
    });
  });

  it("list_memories defaults memory_type to agent_case for an agent owner", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse(listEnvelope),
    );
    vi.stubGlobal("fetch", fetcher);

    await executors["evermem.list_memories"]?.(
      { agentId: "a1" },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.agent_id).toBe("a1");
    expect(body.user_id).toBeUndefined();
    expect(body.memory_type).toBe("agent_case");
  });

  it("list_memories honors agent, memoryType, pagination and sort overrides", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse(listEnvelope),
    );
    vi.stubGlobal("fetch", fetcher);

    await executors["evermem.list_memories"]?.(
      {
        agentId: "a1",
        appId: "app1",
        projectId: "p1",
        memoryType: "agent_case",
        page: 2,
        pageSize: 5,
        sortBy: "updated_at",
        sortOrder: "asc",
      },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      agent_id: "a1",
      app_id: "app1",
      project_id: "p1",
      memory_type: "agent_case",
      page: 2,
      page_size: 5,
      sort_by: "updated_at",
      sort_order: "asc",
    });
  });
});

describe("evermem trigger_maintenance", () => {
  it("posts the strategy with default timeout/force and returns the unwrapped response", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ request_id: "r", status: "ok", name: "reflect_episodes" }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.trigger_maintenance"]?.(
      { name: "reflect_episodes" },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    // ome/trigger returns TriggerResponse directly (no {request_id, data} envelope).
    expect(result).toEqual({ ok: true, output: { request_id: "r", status: "ok", name: "reflect_episodes" } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://evercore.incandgold.cc/api/v1/ome/trigger");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Headers).get("Authorization")).toBe("Bearer secret");
    expect(JSON.parse(init!.body as string)).toEqual({ name: "reflect_episodes", timeout: 120, force: false });
  });

  it("honors timeout and force overrides", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ status: "timeout", name: "reflect_episodes" }),
    );
    vi.stubGlobal("fetch", fetcher);

    await executors["evermem.trigger_maintenance"]?.(
      { name: "reflect_episodes", timeout: 5, force: true },
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      name: "reflect_episodes",
      timeout: 5,
      force: true,
    });
  });

  it("rejects a missing strategy name without calling the API", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse({}),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["evermem.trigger_maintenance"]?.(
      {},
      { getCredential: async () => apiKeyCredential("secret", { baseUrl }) },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

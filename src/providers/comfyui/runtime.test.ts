import type { TransitFileWriter } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { customCredential } from "../kd-test-helpers.ts";
import { credentialValidators, executors } from "./executors.ts";
import { defaultComfyuiBaseUrl, normalizeComfyuiBaseUrl, resolveComfyuiBaseUrl } from "./runtime.ts";

// The provider only reaches its self-hosted target when the deployment opts in
// through OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK; mirror that here.
beforeEach(() => {
  setPrivateNetworkAccessAllowed(true);
});

afterEach(() => {
  setPrivateNetworkAccessAllowed(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The multipart filename the provider sent to ComfyUI's input folder. */
function uploadedNames(fetcher: ReturnType<typeof vi.fn<Fetcher>>): string[] {
  return fetcher.mock.calls
    .filter(([url]) => String(url).endsWith("/upload/image"))
    .map(([, init]) => ((init!.body as FormData).get("image") as File).name);
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const systemStats = { system: { comfyui_version: "0.25.0", os: "darwin" }, devices: [{ name: "mps" }] };

const checkpointInfo = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sd15.safetensors", "sdXL_base.safetensors"], {}] } } },
};

const samplerInfo = {
  KSampler: {
    input: { required: { sampler_name: [["euler", "dpmpp_2m"], {}], scheduler: [["normal", "karras"], {}] } },
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function png(): Response {
  return new Response("\x89PNG\r\n\x1a\n", { status: 200, headers: { "content-type": "image/png" } });
}

/** Route fake ComfyUI responses by URL path so ordering stays readable. */
function routedFetcher(routes: Array<[RegExp, () => Response]>): ReturnType<typeof vi.fn<Fetcher>> {
  return vi.fn<Fetcher>(async (input) => {
    const url = String(input);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) {
      throw new Error(`unexpected request: ${url}`);
    }
    return route[1]();
  });
}

function jsonFetcher(body: unknown, status = 200): ReturnType<typeof vi.fn<Fetcher>> {
  return vi.fn<Fetcher>(async () => json(body, status));
}

function fakeTransitFiles(): TransitFileWriter & { create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (file: File) => ({
    fileId: "file_1",
    downloadUrl: "http://transit.local/files/file_1",
    sizeBytes: 4242,
    name: file.name,
    mimeType: file.type,
  }));
  const read = vi.fn(async () => ({
    file: new File(["source-bytes"], "source.png", { type: "image/png" }),
    sizeBytes: 12,
    name: "source.png",
    mimeType: "image/png",
  }));
  return { maxBytes: 50_000_000, create, read, delete: vi.fn() } as unknown as TransitFileWriter & {
    create: ReturnType<typeof vi.fn>;
  };
}

function actionContext(transitFiles?: TransitFileWriter) {
  return { getCredential: async () => customCredential({}), transitFiles };
}

/** History for a finished job that saved one image. */
function finishedHistory(promptId: string) {
  return {
    [promptId]: {
      status: { status_str: "success", completed: true },
      outputs: { save: { images: [{ filename: "open-connector_00001_.png", subfolder: "", type: "output" }] } },
    },
  };
}

describe("normalizeComfyuiBaseUrl", () => {
  it("defaults a blank value to the OrbStack host gateway", () => {
    expect(normalizeComfyuiBaseUrl("   ")).toBe(defaultComfyuiBaseUrl);
    expect(normalizeComfyuiBaseUrl(undefined)).toBe(defaultComfyuiBaseUrl);
  });

  it("keeps http and strips a trailing slash", () => {
    expect(normalizeComfyuiBaseUrl("http://host.docker.internal:8188/")).toBe("http://host.docker.internal:8188");
  });

  it("rejects a non-http(s) protocol and a non-URL", () => {
    expect(() => normalizeComfyuiBaseUrl("ftp://host")).toThrow(/http or https/u);
    expect(() => normalizeComfyuiBaseUrl("not a url")).toThrow(/valid URL/u);
  });
});

describe("resolveComfyuiBaseUrl", () => {
  it("prefers metadata over values and falls back to the default", () => {
    expect(resolveComfyuiBaseUrl({ values: { baseUrl: "http://a:1" }, metadata: { baseUrl: "http://b:2" } })).toBe(
      "http://b:2",
    );
    expect(resolveComfyuiBaseUrl({ values: {}, metadata: {} })).toBe(defaultComfyuiBaseUrl);
  });
});

describe("comfyui credential validation", () => {
  it("hits /system_stats and stores the base URL + version", async () => {
    const fetcher = jsonFetcher(systemStats);

    const result = await credentialValidators.customCredential?.({ values: {} }, { fetcher });

    expect(result).toEqual({
      profile: {
        accountId: "comfyui:host.docker.internal:8188",
        displayName: "ComfyUI (host.docker.internal:8188)",
      },
      grantedScopes: [],
      metadata: { baseUrl: "http://host.docker.internal:8188", comfyuiVersion: "0.25.0" },
    });
    expect(fetcher.mock.calls[0]![0]).toBe("http://host.docker.internal:8188/system_stats");
  });

  it("rejects a response that is not ComfyUI", async () => {
    const fetcher = jsonFetcher({ status: "up" });
    await expect(credentialValidators.customCredential?.({ values: {} }, { fetcher })).rejects.toThrow(
      /unexpected response/u,
    );
  });
});

describe("comfyui.list_models", () => {
  it("reads the checkpoint, sampler, and scheduler enums from the narrow object_info endpoints", async () => {
    const fetcher = routedFetcher([
      [/CheckpointLoaderSimple/u, () => json(checkpointInfo)],
      [/KSampler/u, () => json(samplerInfo)],
    ]);
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["comfyui.list_models"]?.({}, actionContext());

    expect(result).toMatchObject({
      ok: true,
      output: {
        checkpoints: ["sd15.safetensors", "sdXL_base.safetensors"],
        samplers: ["euler", "dpmpp_2m"],
        schedulers: ["normal", "karras"],
      },
    });
  });

  it("returns empty lists when the node shape is unknown", async () => {
    const fetcher = jsonFetcher({});
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["comfyui.list_models"]?.({}, actionContext());

    expect(result).toMatchObject({ ok: true, output: { checkpoints: [], samplers: [], schedulers: [] } });
  });
});

describe("comfyui.txt2img", () => {
  it("auto-picks an SDXL checkpoint, submits the graph, polls history, and stores the image", async () => {
    const fetcher = routedFetcher([
      [/object_info/u, () => json(checkpointInfo)],
      [/\/prompt$/u, () => json({ prompt_id: "p1" })],
      [/\/history\//u, () => json(finishedHistory("p1"))],
      [/\/view\?/u, () => png()],
    ]);
    vi.stubGlobal("fetch", fetcher);
    const transitFiles = fakeTransitFiles();

    const result = await executors["comfyui.txt2img"]?.(
      { prompt: "a red fox in snow", seed: 7, steps: 8, width: 768, height: 512, filename: "my fox" },
      actionContext(transitFiles),
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        promptId: "p1",
        seed: 7,
        images: [
          {
            name: "my_fox.png",
            mimeType: "image/png",
            downloadUrl: "http://transit.local/files/file_1",
            fileId: "file_1",
            sizeBytes: 4242,
          },
        ],
      },
    });

    const submit = fetcher.mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    const body = JSON.parse(submit[1]!.body as string) as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    expect(body.prompt.ckpt!.inputs.ckpt_name).toBe("sdXL_base.safetensors");
    expect(body.prompt.latent!.inputs).toMatchObject({ width: 768, height: 512, batch_size: 1 });
    expect(body.prompt.sampler!.inputs).toMatchObject({ seed: 7, steps: 8, denoise: 1, sampler_name: "dpmpp_2m" });
    expect(body.prompt.pos!.inputs.text).toBe("a red fox in snow");

    const view = fetcher.mock.calls.find(([url]) => String(url).includes("/view?"))!;
    expect(String(view[0])).toContain("filename=open-connector_00001_.png");
    expect(transitFiles.create).toHaveBeenCalledOnce();
  });

  it("fails without transit storage", async () => {
    vi.stubGlobal("fetch", jsonFetcher(checkpointInfo));

    const result = await executors["comfyui.txt2img"]?.({ prompt: "x" }, actionContext());

    expect(result).toMatchObject({ ok: false });
  });

  it("maps a rejected graph to an invalid-input result naming the failing node", async () => {
    const fetcher = routedFetcher([
      [/object_info/u, () => json(checkpointInfo)],
      [
        /\/prompt$/u,
        () =>
          json(
            {
              error: { message: "Prompt has no outputs", details: "" },
              node_errors: { sampler: { errors: [{ message: "Value not in list", details: "sampler_name" }] } },
            },
            400,
          ),
      ],
    ]);
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["comfyui.txt2img"]?.(
      { prompt: "x", sampler: "nope" },
      actionContext(fakeTransitFiles()),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.stringContaining("node sampler: Value not in list") },
    });
  });

  it("surfaces an execution error reported in history", async () => {
    const fetcher = routedFetcher([
      [/object_info/u, () => json(checkpointInfo)],
      [/\/prompt$/u, () => json({ prompt_id: "p1" })],
      [
        /\/history\//u,
        () =>
          json({
            p1: {
              status: { status_str: "error", completed: false, messages: [["execution_error", { node: "ckpt" }]] },
            },
          }),
      ],
    ]);
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["comfyui.txt2img"]?.({ prompt: "x" }, actionContext(fakeTransitFiles()));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "provider_error", message: expect.stringContaining("execution_error") },
    });
  });
});

describe("comfyui.img2img", () => {
  it("uploads the transit source image and wires it into the LoadImage node", async () => {
    const fetcher = routedFetcher([
      [/object_info/u, () => json(checkpointInfo)],
      [/\/upload\/image$/u, () => json({ name: "source.png", subfolder: "clipspace" })],
      [/\/prompt$/u, () => json({ prompt_id: "p2" })],
      [/\/history\//u, () => json(finishedHistory("p2"))],
      [/\/view\?/u, () => png()],
    ]);
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["comfyui.img2img"]?.(
      { prompt: "as an oil painting", image: { fileId: "file_src" }, denoise: 0.55 },
      actionContext(fakeTransitFiles()),
    );

    expect(result).toMatchObject({ ok: true, output: { promptId: "p2", images: [{ name: "comfyui.png" }] } });

    const submit = fetcher.mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    const body = JSON.parse(submit[1]!.body as string) as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    // The ComfyUI-side name is qualified with the transit file id so a second
    // job uploading its own "source.png" cannot overwrite this one.
    expect(uploadedNames(fetcher)).toEqual(["file_src-source.png"]);
    expect(body.prompt.load!.inputs.image).toBe("clipspace/source.png");
    expect(body.prompt.encode!.inputs).toMatchObject({ pixels: ["load", 0] });
    expect(body.prompt.sampler!.inputs.denoise).toBe(0.55);
  });
});

describe("comfyui.inpaint", () => {
  it("uploads both the image and the mask and encodes for inpainting", async () => {
    const uploads: string[] = [];
    const fetcher = routedFetcher([
      [/object_info/u, () => json(checkpointInfo)],
      [
        /\/upload\/image$/u,
        () => {
          uploads.push("upload");
          return json({ name: uploads.length === 1 ? "base.png" : "mask.png" });
        },
      ],
      [/\/prompt$/u, () => json({ prompt_id: "p3" })],
      [/\/history\//u, () => json(finishedHistory("p3"))],
      [/\/view\?/u, () => png()],
    ]);
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["comfyui.inpaint"]?.(
      { prompt: "an aurora", image: { fileId: "file_a" }, mask: { fileId: "file_b" } },
      actionContext(fakeTransitFiles()),
    );

    expect(result).toMatchObject({ ok: true, output: { promptId: "p3" } });
    expect(uploads).toHaveLength(2);
    // Distinct transit ids keep the image and the mask apart even when both
    // carry the same display name.
    expect(uploadedNames(fetcher)).toEqual(["file_a-source.png", "file_b-source.png"]);

    const submit = fetcher.mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    const body = JSON.parse(submit[1]!.body as string) as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    expect(body.prompt.load!.inputs.image).toBe("base.png");
    expect(body.prompt.loadmask!.inputs).toMatchObject({ image: "mask.png", channel: "red" });
    expect(body.prompt.encode!.inputs).toMatchObject({ mask: ["loadmask", 0], grow_mask_by: 6 });
    expect(body.prompt.sampler!.inputs.denoise).toBe(1);
  });
});

describe("comfyui upload and checkpoint failures", () => {
  it("maps a rejected /upload/image to the upstream status", async () => {
    const fetcher = routedFetcher([
      [/object_info/u, () => json(checkpointInfo)],
      [/\/upload\/image$/u, () => new Response("input folder is read-only", { status: 500 })],
    ]);
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["comfyui.img2img"]?.(
      { prompt: "x", image: { fileId: "file_src" } },
      actionContext(fakeTransitFiles()),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "provider_error", message: expect.stringContaining("input folder is read-only") },
    });
  });

  it("reports a ComfyUI instance with no checkpoints installed", async () => {
    vi.stubGlobal("fetch", jsonFetcher({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[], {}] } } } }));

    const result = await executors["comfyui.txt2img"]?.({ prompt: "x" }, actionContext(fakeTransitFiles()));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "provider_error", message: expect.stringContaining("no checkpoints installed") },
    });
  });
});

describe("comfyui history polling", () => {
  /** Routes for a job whose history is served by `history` on every poll. */
  function pollingFetcher(history: () => Response) {
    return routedFetcher([
      [/object_info/u, () => json(checkpointInfo)],
      [/\/prompt$/u, () => json({ prompt_id: "p5" })],
      [/\/history\//u, history],
      [/\/view\?/u, () => png()],
    ]);
  }

  it("keeps polling until the job reports its outputs", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const fetcher = pollingFetcher(() => {
      polls += 1;
      // ComfyUI serves an empty history object while the prompt is queued.
      return json(polls < 3 ? {} : finishedHistory("p5"));
    });
    vi.stubGlobal("fetch", fetcher);

    const pending = executors["comfyui.txt2img"]?.({ prompt: "x" }, actionContext(fakeTransitFiles()));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toMatchObject({ ok: true, output: { promptId: "p5", images: [{ fileId: "file_1" }] } });
    expect(polls).toBe(3);
  });

  it("times out with a message naming the prompt id", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      pollingFetcher(() => json({})),
    );

    const pending = executors["comfyui.txt2img"]?.({ prompt: "x", waitSeconds: 2 }, actionContext(fakeTransitFiles()));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "provider_error", message: expect.stringContaining("ComfyUI prompt p5") },
    });
  });

  it("fails fast when a completed job saved no image", async () => {
    vi.stubGlobal(
      "fetch",
      pollingFetcher(() => json({ p5: { status: { completed: true }, outputs: {} } })),
    );

    const result = await executors["comfyui.txt2img"]?.({ prompt: "x" }, actionContext(fakeTransitFiles()));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "provider_error", message: expect.stringContaining("produced no image output") },
    });
  });
});

describe("comfyui.run_workflow", () => {
  it("forwards the graph as-is and returns every emitted image without a seed", async () => {
    const fetcher = routedFetcher([
      [/\/prompt$/u, () => json({ prompt_id: "p4" })],
      [
        /\/history\//u,
        () =>
          json({
            p4: {
              status: { status_str: "success", completed: true },
              outputs: {
                other: {
                  images: [
                    { filename: "a.png", subfolder: "", type: "output" },
                    { filename: "b.webp", subfolder: "sub", type: "output" },
                  ],
                },
              },
            },
          }),
      ],
      [/\/view\?/u, () => png()],
    ]);
    vi.stubGlobal("fetch", fetcher);

    const graph = { "1": { class_type: "SaveImage", inputs: { images: ["2", 0] } } };
    const result = await executors["comfyui.run_workflow"]?.({ workflow: graph }, actionContext(fakeTransitFiles()));

    expect(result).toMatchObject({
      ok: true,
      output: { promptId: "p4", images: [{ name: "comfyui-1.png" }, { name: "comfyui-2.webp" }] },
    });
    expect((result as { output: Record<string, unknown> }).output.seed).toBeUndefined();

    const submit = fetcher.mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    expect(JSON.parse(submit[1]!.body as string)).toMatchObject({ prompt: graph });
  });

  it("rejects a missing workflow before calling ComfyUI", async () => {
    const fetcher = jsonFetcher({});
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["comfyui.run_workflow"]?.({}, actionContext(fakeTransitFiles()));

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

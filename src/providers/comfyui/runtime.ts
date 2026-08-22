import type { CredentialValidationResult, TransitFileWriter } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { ComfyuiSamplingOptions, ComfyuiWorkflow } from "./workflows.ts";

import {
  compactObject,
  optionalInteger,
  optionalNumber,
  optionalRecord,
  optionalString,
  optionalStringArray,
  requiredRecord,
  requiredString,
} from "../../core/cast.ts";
import { encodePathSegment } from "../../core/request.ts";
import {
  ProviderRequestError,
  providerUserAgent,
  readProviderErrorTextBody,
  readProviderJsonBody,
  readTransitFileInput,
  setSearchParams,
  uploadProviderUrlToTransitFile,
} from "../provider-runtime.ts";
import { buildImg2imgWorkflow, buildInpaintWorkflow, buildTxt2imgWorkflow, comfyuiSaveNodeId } from "./workflows.ts";

// Both the connector container and the self-hosted ComfyUI run on the same
// OrbStack host, so the default targets ComfyUI over the host gateway with no
// tunnel and no auth. Mirrors searxng/openscad.
export const defaultComfyuiBaseUrl = "http://host.docker.internal:8188";

const systemStatsPath = "/system_stats";
const checkpointLoaderNode = "CheckpointLoaderSimple";
const ksamplerNode = "KSampler";

const defaultNegativePrompt = "text, watermark, low quality, blurry";
const defaultSampler = "dpmpp_2m";
const defaultScheduler = "karras";
const defaultSteps = 25;
const defaultCfg = 7;
const defaultSize = 1024;
const defaultWaitSeconds = 240;
const maxWaitSeconds = 600;
const pollIntervalMs = 1_500;

export interface ComfyuiActionContext {
  baseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  transitFiles?: TransitFileWriter;
}

/** An action context proven to have the transit storage every job writes to. */
interface ComfyuiJobContext extends ComfyuiActionContext {
  transitFiles: TransitFileWriter;
}

/** The two job-level inputs every generation action shares. */
interface ComfyuiJobOptions {
  waitSeconds: number;
  baseName: string;
}

type ComfyuiActionHandler = (input: Record<string, unknown>, context: ComfyuiActionContext) => Promise<unknown>;

/** Action handlers keyed by the local action name (no service prefix). */
export const comfyuiActionHandlers: ProviderActionHandlers<"comfyui", ComfyuiActionHandler> = {
  system_stats: (_input, context) => comfyuiGetJson(context, systemStatsPath),
  list_models: (_input, context) => listComfyuiModels(context),
  txt2img: (input, context) => generate(input, context, "txt2img"),
  img2img: (input, context) => generate(input, context, "img2img"),
  inpaint: (input, context) => generate(input, context, "inpaint"),
  run_workflow: runWorkflow,
};

/**
 * Parse the admin-configured self-hosted ComfyUI base URL. Like searxng and
 * openscad, this deliberately permits http and private/`.internal` hosts and
 * does NOT call `assertPublicHttpUrl`: the value is set by an admin at
 * connection time and points at a co-located ComfyUI instance.
 */
export function normalizeComfyuiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  const raw = trimmed && trimmed.length > 0 ? trimmed : defaultComfyuiBaseUrl;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderRequestError(400, "baseUrl must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderRequestError(400, "baseUrl must use http or https");
  }

  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

export function resolveComfyuiBaseUrl(input: {
  values: Record<string, string>;
  metadata: Record<string, unknown>;
}): string {
  return normalizeComfyuiBaseUrl(optionalString(input.metadata.baseUrl) ?? optionalString(input.values.baseUrl));
}

export async function validateComfyuiCredential(
  input: { values: Record<string, string> },
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const baseUrl = normalizeComfyuiBaseUrl(input.values.baseUrl);
  const payload = optionalRecord(await comfyuiGetJson({ baseUrl, fetcher, signal }, systemStatsPath));

  // A real ComfyUI answers /system_stats with a system block and a device list.
  // Guard against a stray 200 from an unrelated service validating green.
  const system = optionalRecord(payload?.system);
  if (!payload || (!system && payload.devices === undefined)) {
    throw new ProviderRequestError(502, "unexpected response from ComfyUI; check the base URL");
  }

  const host = new URL(baseUrl).host;
  return {
    profile: {
      accountId: `comfyui:${host}`,
      displayName: `ComfyUI (${host})`,
    },
    grantedScopes: [],
    metadata: compactObject({
      baseUrl,
      comfyuiVersion: optionalString(system?.comfyui_version),
    }),
  };
}

/**
 * Read the installed checkpoints and the sampler/scheduler enums from the two
 * narrow `/object_info/<node>` endpoints. The full `/object_info` response is
 * several megabytes, so it is never fetched.
 */
async function listComfyuiModels(context: ComfyuiActionContext): Promise<unknown> {
  const [checkpointInfo, samplerInfo] = await Promise.all([
    comfyuiGetJson(context, `/object_info/${checkpointLoaderNode}`),
    comfyuiGetJson(context, `/object_info/${ksamplerNode}`),
  ]);

  return {
    checkpoints: readNodeEnum(checkpointInfo, checkpointLoaderNode, "ckpt_name"),
    samplers: readNodeEnum(samplerInfo, ksamplerNode, "sampler_name"),
    schedulers: readNodeEnum(samplerInfo, ksamplerNode, "scheduler"),
  };
}

/**
 * ComfyUI describes a combo input as `[[...choices], {...}]` under
 * `<node>.input.required.<field>`; anything else means the node is missing or
 * the shape changed.
 */
function readNodeEnum(payload: unknown, node: string, field: string): string[] {
  const required = optionalRecord(optionalRecord(optionalRecord(payload)?.[node])?.input)?.required;
  const entry = optionalRecord(required)?.[field];
  const choices = Array.isArray(entry) ? entry[0] : undefined;
  return optionalStringArray(choices) ?? [];
}

type GenerationMode = "txt2img" | "img2img" | "inpaint";

/** Per-mode denoise defaults; txt2img always samples from scratch. */
const defaultDenoise: Record<GenerationMode, number> = { txt2img: 1, img2img: 0.7, inpaint: 1 };

async function generate(
  input: Record<string, unknown>,
  context: ComfyuiActionContext,
  mode: GenerationMode,
): Promise<unknown> {
  const jobContext = requireTransitFiles(context);
  const started = Date.now();
  const seed = optionalInteger(input.seed) ?? randomSeed();
  const sampling: Omit<ComfyuiSamplingOptions, "checkpoint"> = {
    prompt: requiredString(input.prompt, "prompt", invalidInput),
    negative: optionalString(input.negative) ?? defaultNegativePrompt,
    seed,
    steps: optionalInteger(input.steps) ?? defaultSteps,
    cfg: optionalNumber(input.cfg) ?? defaultCfg,
    sampler: optionalString(input.sampler) ?? defaultSampler,
    scheduler: optionalString(input.scheduler) ?? defaultScheduler,
    denoise: mode === "txt2img" ? 1 : (optionalNumber(input.denoise) ?? defaultDenoise[mode]),
  };

  // Start the checkpoint lookup before the uploads so buildWorkflow can await
  // both in one round trip.
  const checkpoint = optionalString(input.checkpoint) ?? discoverCheckpoint(context);
  const workflow = await buildWorkflow(input, context, mode, sampling, checkpoint);
  const promptId = await submitWorkflow(context, workflow);
  const images = await collectImages(promptId, readJobOptions(input), jobContext);
  return { promptId, seed, images, durationMs: Date.now() - started };
}

async function buildWorkflow(
  input: Record<string, unknown>,
  context: ComfyuiActionContext,
  mode: GenerationMode,
  sampling: Omit<ComfyuiSamplingOptions, "checkpoint">,
  checkpointInput: string | Promise<string>,
): Promise<ComfyuiWorkflow> {
  if (mode === "txt2img") {
    return buildTxt2imgWorkflow({
      ...sampling,
      checkpoint: await checkpointInput,
      width: optionalInteger(input.width) ?? defaultSize,
      height: optionalInteger(input.height) ?? defaultSize,
      batchSize: optionalInteger(input.batchSize) ?? 1,
    });
  }

  // The checkpoint lookup and the image uploads are independent pre-submit
  // round trips, so inpaint pays one of them instead of three.
  if (mode === "img2img") {
    const [checkpoint, imageName] = await Promise.all([
      checkpointInput,
      uploadInputImage(input.image, "image", context),
    ]);
    return buildImg2imgWorkflow({ ...sampling, checkpoint, imageName });
  }
  const [checkpoint, imageName, maskName] = await Promise.all([
    checkpointInput,
    uploadInputImage(input.image, "image", context),
    uploadInputImage(input.mask, "mask", context),
  ]);
  return buildInpaintWorkflow({ ...sampling, checkpoint, imageName, maskName });
}

async function runWorkflow(input: Record<string, unknown>, context: ComfyuiActionContext): Promise<unknown> {
  const jobContext = requireTransitFiles(context);
  const started = Date.now();
  const workflow = requiredRecord(input.workflow, "workflow", invalidInput);
  const promptId = await submitWorkflow(context, workflow);
  const images = await collectImages(promptId, readJobOptions(input), jobContext);
  return { promptId, images, durationMs: Date.now() - started };
}

function readJobOptions(input: Record<string, unknown>): ComfyuiJobOptions {
  return {
    waitSeconds: Math.min(optionalInteger(input.waitSeconds) ?? defaultWaitSeconds, maxWaitSeconds),
    baseName: sanitizeFilename(optionalString(input.filename)),
  };
}

/** Pick an installed checkpoint, preferring an SDXL one, when none was given. */
async function discoverCheckpoint(context: ComfyuiActionContext): Promise<string> {
  const info = await comfyuiGetJson(context, `/object_info/${checkpointLoaderNode}`);
  const names = readNodeEnum(info, checkpointLoaderNode, "ckpt_name");
  const checkpoint = names.find((name) => name.toLowerCase().includes("xl")) ?? names[0];
  if (!checkpoint) {
    throw new ProviderRequestError(502, "ComfyUI has no checkpoints installed; pass an explicit checkpoint");
  }
  return checkpoint;
}

/**
 * Push one transit file into ComfyUI's input folder and return the name
 * `LoadImage`/`LoadImageMask` resolves, qualified with the server-chosen
 * subfolder when there is one.
 */
async function uploadInputImage(reference: unknown, field: string, context: ComfyuiActionContext): Promise<string> {
  const stored = await readTransitFileInput(reference, context);
  const body = new FormData();
  body.set("type", "input");
  // Qualify the ComfyUI-side name with the transit file id: the display name is
  // caller-controlled and collides easily (every image this provider returns is
  // named "comfyui.png"). Two uploads sharing a name would clobber each other in
  // ComfyUI's input folder — across concurrent jobs, and even within one inpaint
  // call whose image and mask arrive with the same name. Same fileId means same
  // bytes, so overwriting is only ever a no-op once the name is unique.
  body.set("overwrite", "true");
  body.set("image", stored.file, `${stored.fileId}-${sanitizeFilename(stored.name)}`);

  const response = await comfyuiFetch(context, "/upload/image", { method: "POST", body });
  if (!response.ok) {
    throw new ProviderRequestError(
      response.status || 502,
      `ComfyUI rejected the ${field} upload: ${await readComfyuiErrorText(response)}`,
    );
  }

  const payload = optionalRecord(await readComfyuiJsonBody(response));
  const name = optionalString(payload?.name);
  if (!name) {
    throw new ProviderRequestError(502, `unexpected /upload/image response for ${field}`);
  }
  const subfolder = optionalString(payload?.subfolder);
  return subfolder ? `${subfolder}/${name}` : name;
}

async function submitWorkflow(context: ComfyuiActionContext, workflow: Record<string, unknown>): Promise<string> {
  const response = await comfyuiFetch(context, "/prompt", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }),
    body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
  });

  const payload = await readComfyuiJsonBody(response);
  if (!response.ok) {
    // ComfyUI rejects a bad graph with 400 and {error, node_errors}; surface
    // both so the caller sees which node failed validation.
    throw new ProviderRequestError(
      response.status || 502,
      readWorkflowErrorMessage(payload) ?? `ComfyUI rejected the workflow with HTTP ${response.status}`,
      payload,
    );
  }

  // A 200 can still carry a validation error object instead of a prompt id.
  const workflowError = readWorkflowErrorMessage(payload);
  if (workflowError) {
    throw new ProviderRequestError(400, workflowError, payload);
  }
  const promptId = optionalString(optionalRecord(payload)?.prompt_id);
  if (!promptId) {
    throw new ProviderRequestError(502, "ComfyUI did not return a prompt_id");
  }
  return promptId;
}

/**
 * Poll `/history/{promptId}` until the job reports outputs or fails, then store
 * every emitted image in transit storage.
 */
async function collectImages(promptId: string, job: ComfyuiJobOptions, context: ComfyuiJobContext): Promise<unknown[]> {
  const deadline = Date.now() + job.waitSeconds * 1000;

  while (true) {
    const history = optionalRecord(await comfyuiGetJson(context, `/history/${encodePathSegment(promptId)}`));
    const entry = optionalRecord(history?.[promptId]);
    if (entry) {
      const status = optionalRecord(entry.status);
      if (optionalString(status?.status_str) === "error") {
        throw new ProviderRequestError(502, `ComfyUI workflow execution failed: ${readStatusMessages(status)}`, status);
      }
      const images = readHistoryImages(entry.outputs);
      if (images.length > 0) {
        return Promise.all(images.map((image, index) => downloadImage(image, index, images.length, job, context)));
      }
      if (status?.completed === true) {
        throw new ProviderRequestError(502, "ComfyUI workflow completed but produced no image output");
      }
    }

    if (Date.now() >= deadline) {
      throw new ProviderRequestError(
        504,
        `timed out after ${job.waitSeconds}s waiting for ComfyUI prompt ${promptId}; the job may still be running`,
      );
    }
    await delay(pollIntervalMs, context.signal);
  }
}

interface ComfyuiHistoryImage {
  filename: string;
  subfolder: string;
  type: string;
}

/**
 * Flatten the image references a finished job emitted. The builders always name
 * their SaveImage node "save", so that node's images come first; any other node
 * that emitted images follows in declaration order.
 */
function readHistoryImages(outputs: unknown): ComfyuiHistoryImage[] {
  const nodes = optionalRecord(outputs);
  if (!nodes) {
    return [];
  }
  const ordered = [
    ...(nodes[comfyuiSaveNodeId] === undefined ? [] : [nodes[comfyuiSaveNodeId]]),
    ...Object.entries(nodes)
      .filter(([nodeId]) => nodeId !== comfyuiSaveNodeId)
      .map(([, value]) => value),
  ];

  const images: ComfyuiHistoryImage[] = [];
  for (const node of ordered) {
    const entries = optionalRecord(node)?.images;
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      const image = optionalRecord(entry);
      const filename = optionalString(image?.filename);
      // Preview nodes emit temp images alongside the saved ones; keep every
      // reference ComfyUI reports and let the caller pick.
      if (filename) {
        images.push({
          filename,
          subfolder: optionalString(image?.subfolder) ?? "",
          type: optionalString(image?.type) ?? "output",
        });
      }
    }
  }
  return images;
}

/**
 * Fetch one emitted image from `/view` and store it in transit storage. The
 * shared helper owns the bounded read, the 413/502 mapping, and the returned
 * `ProviderTransitFile` shape.
 */
async function downloadImage(
  image: ComfyuiHistoryImage,
  index: number,
  total: number,
  job: ComfyuiJobOptions,
  context: ComfyuiJobContext,
): Promise<unknown> {
  const url = new URL(`${context.baseUrl}/view`);
  setSearchParams(url, { filename: image.filename, subfolder: image.subfolder, type: image.type });

  const extension = image.filename.includes(".") ? image.filename.slice(image.filename.lastIndexOf(".") + 1) : "png";
  const name = total > 1 ? `${job.baseName}-${index + 1}.${extension}` : `${job.baseName}.${extension}`;
  const stored = await uploadProviderUrlToTransitFile(
    { url: url.toString(), name, source: `ComfyUI image ${image.filename}` },
    context,
  );
  if (!stored) {
    throw new ProviderRequestError(400, "Transit file storage is not enabled.");
  }
  return stored;
}

function requireTransitFiles(context: ComfyuiActionContext): ComfyuiJobContext {
  if (!context.transitFiles) {
    throw new ProviderRequestError(400, "Transit file storage is not enabled.");
  }
  return { ...context, transitFiles: context.transitFiles };
}

/** Sampler seed inside Number.MAX_SAFE_INTEGER so it survives JSON round-trips. */
function randomSeed(): number {
  const [high, low] = crypto.getRandomValues(new Uint32Array(2));
  return (high! % 2 ** 21) * 2 ** 32 + low!;
}

function sanitizeFilename(value: string | undefined): string {
  const base = (value ?? "comfyui").replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^[._]+/u, "");
  return base || "comfyui";
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new ProviderRequestError(499, "ComfyUI request was cancelled"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new ProviderRequestError(499, "ComfyUI request was cancelled"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Issue a request to ComfyUI, normalizing transport failures to 502. */
async function comfyuiFetchUrl(
  context: Pick<ComfyuiActionContext, "fetcher" | "signal">,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("user-agent", providerUserAgent);
  try {
    return await context.fetcher(url, { ...init, headers, signal: context.signal });
  } catch (error) {
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `ComfyUI request failed: ${error.message}` : "ComfyUI request failed",
    );
  }
}

function comfyuiFetch(
  context: Pick<ComfyuiActionContext, "baseUrl" | "fetcher" | "signal">,
  path: string,
  init: RequestInit,
): Promise<Response> {
  return comfyuiFetchUrl(context, new URL(`${context.baseUrl}${path}`).toString(), init);
}

async function comfyuiGetJson(
  context: Pick<ComfyuiActionContext, "baseUrl" | "fetcher" | "signal">,
  path: string,
): Promise<unknown> {
  const response = await comfyuiFetch(context, path, {
    method: "GET",
    headers: new Headers({ accept: "application/json" }),
  });
  const payload = await readComfyuiJsonBody(response);
  if (!response.ok) {
    throw new ProviderRequestError(
      response.status || 502,
      readWorkflowErrorMessage(payload) ?? `ComfyUI request failed with ${response.status}`,
      payload,
    );
  }
  return payload;
}

function readComfyuiJsonBody(response: Response): Promise<unknown> {
  return readProviderJsonBody(response, {
    emptyBody: {},
    invalidJsonMessage: "ComfyUI returned a non-JSON response",
    // ComfyUI serves plain-text tracebacks on some failures; keep them as the
    // error payload instead of turning a readable message into a parse error.
    invalidJsonFallback: (text) => (response.ok ? { data: text } : text),
  });
}

async function readComfyuiErrorText(response: Response): Promise<string> {
  const text = await readProviderErrorTextBody(response, "ComfyUI error response");
  return text || `HTTP ${response.status}`;
}

/**
 * ComfyUI reports a rejected graph as `{error: {message, details}, node_errors:
 * {<nodeId>: {errors: [{message, details}]}}}`. Flatten it into one line so the
 * failing node is visible without digging into the details payload.
 */
function readWorkflowErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    return payload || undefined;
  }
  const body = optionalRecord(payload);
  if (!body) {
    return undefined;
  }

  const error = optionalRecord(body.error);
  const head = error ? joinMessageDetails(error) : optionalString(body.error);

  const nodeErrors = optionalRecord(body.node_errors);
  const nodeParts = Object.entries(nodeErrors ?? {}).map(([nodeId, value]) => {
    const errors = optionalRecord(value)?.errors;
    const messages = Array.isArray(errors)
      ? errors.map((item) => joinMessageDetails(optionalRecord(item))).filter((message) => message.length > 0)
      : [];
    return `node ${nodeId}: ${messages.join("; ") || "invalid"}`;
  });

  const parts = [head, ...nodeParts].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/** ComfyUI states an error as a short `message` plus a longer `details` string. */
function joinMessageDetails(record: Record<string, unknown> | undefined): string {
  return [optionalString(record?.message), optionalString(record?.details)].filter(Boolean).join(": ");
}

/** Execution failures land in history as `status.messages`: [name, payload] pairs. */
function readStatusMessages(status: Record<string, unknown> | undefined): string {
  const messages = status?.messages;
  if (!Array.isArray(messages)) {
    return "no error detail reported";
  }
  return JSON.stringify(messages).slice(0, 800);
}

function invalidInput(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

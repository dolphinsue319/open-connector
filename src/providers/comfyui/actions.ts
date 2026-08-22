import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "comfyui";

const emptyInput = s.looseObject({}, { description: "The input payload for this action." });

// One produced image, stored in local transit storage. Field names match the
// shared `ProviderTransitFile` shape returned by uploadProviderUrlToTransitFile.
const generatedImageSchema: JsonSchema = s.looseRequiredObject("A generated image stored in local transit storage.", {
  name: s.string("The image filename."),
  mimeType: s.string("The image MIME type."),
  downloadUrl: s.string("The transit URL for downloading the image."),
  fileId: s.string("The local transit file identifier."),
  sizeBytes: s.integer("The image size in bytes."),
});

const jobOutputs: Record<string, JsonSchema> = {
  promptId: s.string("The ComfyUI prompt identifier for this job."),
  images: s.array("The images produced by the workflow.", generatedImageSchema),
  durationMs: s.integer("Wall-clock time spent submitting, waiting for, and downloading the job."),
};

// The high-level modes own the sampler seed and report it back; run_workflow
// forwards a caller-built graph and has no seed of its own.
const generationOutput: JsonSchema = s.looseRequiredObject("The generated images.", {
  ...jobOutputs,
  seed: s.integer("The sampler seed that was used."),
});

const workflowOutput: JsonSchema = s.looseRequiredObject("The workflow output images.", jobOutputs);

const waitSecondsInput = s.optional(
  s.positiveInteger("How long to wait for the job to finish. Defaults to 240, maximum 600.", { maximum: 600 }),
);
const filenameInput = s.optional(s.string("Optional base filename (without extension) for the returned images."));

// Only the prompt is required; every other sampling input carries its optional
// marker on the schema itself, so the required list can never drift.
const samplingInputs: Record<string, JsonSchema> = {
  prompt: s.nonEmptyString("The positive prompt describing what to generate."),
  negative: s.optional(s.string("The negative prompt. Defaults to 'text, watermark, low quality, blurry'.")),
  steps: s.optional(s.positiveInteger("The number of sampling steps. Defaults to 25.", { maximum: 150 })),
  cfg: s.optional(
    s.number("The classifier-free guidance scale. Defaults to 7 (SDXL likes 6-8).", { minimum: 0, maximum: 30 }),
  ),
  seed: s.optional(s.nonNegativeInteger("The sampler seed. Omit for a random seed.")),
  checkpoint: s.optional(s.string("The exact ckpt_name to load. Omit to auto-select an installed SDXL checkpoint.")),
  sampler: s.optional(s.string("The KSampler sampler_name. Defaults to dpmpp_2m.")),
  scheduler: s.optional(s.string("The KSampler scheduler. Defaults to karras.")),
  filename: filenameInput,
  waitSeconds: waitSecondsInput,
};

export const comfyuiActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "system_stats",
    description:
      "Report the self-hosted ComfyUI instance status, including its version, OS, RAM, and the torch devices it can use.",
    inputSchema: emptyInput,
    outputSchema: s.looseObject(
      {
        system: s.looseObject({}, { description: "The ComfyUI version and host details." }),
        devices: s.array("The torch devices available to ComfyUI.", s.looseObject({}, { description: "A device." })),
      },
      { description: "The ComfyUI instance status." },
    ),
  }),
  defineProviderAction(service, {
    name: "list_models",
    description:
      "List the checkpoints, samplers, and schedulers installed on the ComfyUI instance, for use as the checkpoint, sampler, and scheduler inputs of the generation actions.",
    inputSchema: emptyInput,
    outputSchema: s.looseRequiredObject("The models and sampling options the instance offers.", {
      checkpoints: s.stringArray("The ckpt_name values CheckpointLoaderSimple accepts."),
      samplers: s.stringArray("The sampler_name values KSampler accepts."),
      schedulers: s.stringArray("The scheduler values KSampler accepts."),
    }),
  }),
  defineProviderAction(service, {
    name: "txt2img",
    description:
      "Generate an image from a text prompt with the self-hosted ComfyUI instance, wait for the job to finish, and return the result as a downloadable transit file.",
    inputSchema: s.looseRequiredObject("The input payload for this action.", {
      ...samplingInputs,
      width: s.optional(s.positiveInteger("The image width in pixels. Defaults to 1024.", { maximum: 4096 })),
      height: s.optional(s.positiveInteger("The image height in pixels. Defaults to 1024.", { maximum: 4096 })),
      batchSize: s.optional(
        s.positiveInteger("How many images to generate in one job. Defaults to 1.", { maximum: 4 }),
      ),
    }),
    outputSchema: generationOutput,
  }),
  defineProviderAction(service, {
    name: "img2img",
    description:
      "Restyle an existing image with a text prompt (image-to-image) on the self-hosted ComfyUI instance and return the result as a downloadable transit file. The output keeps the input image size.",
    inputSchema: s.looseRequiredObject("The input payload for this action.", {
      ...samplingInputs,
      image: s.transitFile("The source image, previously uploaded to the local transit file API."),
      denoise: s.optional(
        s.number("How much of the source image to repaint, 0-1. Defaults to 0.7; lower stays closer to the source.", {
          minimum: 0,
          maximum: 1,
        }),
      ),
    }),
    outputSchema: generationOutput,
  }),
  defineProviderAction(service, {
    name: "inpaint",
    description:
      "Repaint the masked region of an image from a text prompt on the self-hosted ComfyUI instance and return the result as a downloadable transit file. The mask must be the same size as the image, where white marks the region to regenerate.",
    inputSchema: s.looseRequiredObject("The input payload for this action.", {
      ...samplingInputs,
      image: s.transitFile("The base image, previously uploaded to the local transit file API."),
      mask: s.transitFile("The mask image (white = repaint), previously uploaded to the local transit file API."),
      denoise: s.optional(
        s.number("How much of the masked region to repaint, 0-1. Defaults to 1.", { minimum: 0, maximum: 1 }),
      ),
    }),
    outputSchema: generationOutput,
  }),
  defineProviderAction(service, {
    name: "run_workflow",
    description:
      "Run a ComfyUI API-format workflow graph as-is, wait for it to finish, and return every image it saved as a downloadable transit file. Use this for graphs the txt2img, img2img, and inpaint actions cannot express; export the graph from the ComfyUI web UI with 'Save (API Format)'.",
    inputSchema: s.looseRequiredObject("The input payload for this action.", {
      workflow: s.record(s.looseObject({}, { description: "A ComfyUI node: class_type plus its inputs." }), {
        description: "The API-format workflow graph, keyed by node id.",
      }),
      filename: filenameInput,
      waitSeconds: waitSecondsInput,
    }),
    outputSchema: workflowOutput,
  }),
];

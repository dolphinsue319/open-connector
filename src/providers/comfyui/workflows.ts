/**
 * Builders for the SDXL API-format workflow graphs behind the high-level
 * txt2img / img2img / inpaint actions. A graph is the object ComfyUI's
 * `POST /prompt` accepts: node ids mapped to `{ class_type, inputs }`, where an
 * input wired from another node is the `[nodeId, outputIndex]` tuple.
 */

export interface ComfyuiNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

export type ComfyuiWorkflow = Record<string, ComfyuiNode>;

/** The SaveImage node id every builder emits; the result collector prefers it. */
export const comfyuiSaveNodeId = "save";

export interface ComfyuiSamplingOptions {
  prompt: string;
  negative: string;
  checkpoint: string;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  denoise: number;
}

export interface ComfyuiTxt2imgOptions extends ComfyuiSamplingOptions {
  width: number;
  height: number;
  batchSize: number;
}

export interface ComfyuiImg2imgOptions extends ComfyuiSamplingOptions {
  imageName: string;
}

export interface ComfyuiInpaintOptions extends ComfyuiImg2imgOptions {
  maskName: string;
}

export function buildTxt2imgWorkflow(options: ComfyuiTxt2imgOptions): ComfyuiWorkflow {
  return {
    ...baseNodes(options),
    latent: {
      class_type: "EmptyLatentImage",
      inputs: { width: options.width, height: options.height, batch_size: options.batchSize },
    },
    sampler: samplerNode(options, ["latent", 0]),
  };
}

export function buildImg2imgWorkflow(options: ComfyuiImg2imgOptions): ComfyuiWorkflow {
  return {
    ...baseNodes(options),
    load: { class_type: "LoadImage", inputs: { image: options.imageName } },
    encode: { class_type: "VAEEncode", inputs: { pixels: ["load", 0], vae: ["ckpt", 2] } },
    sampler: samplerNode(options, ["encode", 0]),
  };
}

export function buildInpaintWorkflow(options: ComfyuiInpaintOptions): ComfyuiWorkflow {
  return {
    ...baseNodes(options),
    load: { class_type: "LoadImage", inputs: { image: options.imageName } },
    // Load the mask as a MASK directly; white marks the region to regenerate.
    loadmask: { class_type: "LoadImageMask", inputs: { image: options.maskName, channel: "red" } },
    encode: {
      class_type: "VAEEncodeForInpaint",
      inputs: { pixels: ["load", 0], vae: ["ckpt", 2], mask: ["loadmask", 0], grow_mask_by: 6 },
    },
    sampler: samplerNode(options, ["encode", 0]),
  };
}

/** Nodes shared by every mode: checkpoint, both prompts, VAE decode, and save. */
function baseNodes(options: ComfyuiSamplingOptions): ComfyuiWorkflow {
  return {
    ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: options.checkpoint } },
    pos: { class_type: "CLIPTextEncode", inputs: { text: options.prompt, clip: ["ckpt", 1] } },
    neg: { class_type: "CLIPTextEncode", inputs: { text: options.negative, clip: ["ckpt", 1] } },
    decode: { class_type: "VAEDecode", inputs: { samples: ["sampler", 0], vae: ["ckpt", 2] } },
    [comfyuiSaveNodeId]: {
      class_type: "SaveImage",
      inputs: { filename_prefix: "open-connector", images: ["decode", 0] },
    },
  };
}

function samplerNode(options: ComfyuiSamplingOptions, latent: [string, number]): ComfyuiNode {
  return {
    class_type: "KSampler",
    inputs: {
      seed: options.seed,
      steps: options.steps,
      cfg: options.cfg,
      sampler_name: options.sampler,
      scheduler: options.scheduler,
      denoise: options.denoise,
      model: ["ckpt", 0],
      positive: ["pos", 0],
      negative: ["neg", 0],
      latent_image: latent,
    },
  };
}

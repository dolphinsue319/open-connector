import type { ProviderDefinition } from "../../core/types.ts";

import { comfyuiActions } from "./actions.ts";

const service = "comfyui";

/**
 * Self-hosted ComfyUI provider. Targets a locally reachable ComfyUI instance
 * (default http://host.docker.internal:8188, the OrbStack host gateway), so no
 * API key is sent and any public gate in front of the instance is bypassed on
 * the local path. Actions submit an API-format workflow, wait for the job, and
 * return the generated images as downloadable transit files.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "ComfyUI (Self-Hosted)",
  categories: ["Design & Media", "Developer Tools"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "baseUrl",
          label: "Base URL",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "http://host.docker.internal:8188",
          description:
            "Base URL of your self-hosted ComfyUI instance. Leave blank to use http://host.docker.internal:8188 (the OrbStack host gateway). No API key is required; private-network targets need the runtime to enable OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK.",
        },
      ],
      testAction: { actionName: "system_stats", input: {} },
    },
  ],
  homepageUrl: "https://www.comfy.org",
  actions: comfyuiActions,
};

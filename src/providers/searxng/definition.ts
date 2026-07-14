import type { ProviderDefinition } from "../../core/types.ts";

import { searxngActions } from "./actions.ts";

const service = "searxng";

/**
 * Self-hosted SearXNG provider. Targets a locally reachable SearXNG instance
 * (default http://host.docker.internal:8080, the OrbStack host gateway) that runs
 * with its limiter disabled and its JSON API enabled, so no API key is sent and
 * the public Cloudflare Access gate is bypassed on the local path.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "SearXNG (Self-Hosted)",
  categories: ["Data", "Developer Tools"],
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
          placeholder: "http://host.docker.internal:8080",
          description:
            "Base URL of your self-hosted SearXNG instance. Leave blank to use http://host.docker.internal:8080 (the OrbStack host gateway). No API key is required; the instance must have its JSON API enabled (search.formats includes json).",
        },
      ],
      testAction: { actionName: "config", input: {} },
    },
  ],
  homepageUrl: "https://github.com/searxng/searxng",
  actions: searxngActions,
};

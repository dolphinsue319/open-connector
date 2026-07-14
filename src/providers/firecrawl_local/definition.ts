import type { ProviderDefinition } from "../../core/types.ts";

import { firecrawlLocalActions } from "./actions.ts";

const service = "firecrawl_local";

/**
 * Self-hosted Firecrawl provider. Targets a locally reachable Firecrawl REST API
 * (default http://host.docker.internal:3002, the OrbStack host gateway) that runs
 * with USE_DB_AUTHENTICATION=false, so no API key is sent. Distinct from the
 * cloud `firecrawl` provider, which is left untouched.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Firecrawl (Self-Hosted)",
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
          placeholder: "http://host.docker.internal:3002",
          description:
            "Base URL of your self-hosted Firecrawl instance. Leave blank to use http://host.docker.internal:3002 (the OrbStack host gateway). No API key is required when Firecrawl runs with USE_DB_AUTHENTICATION=false.",
        },
      ],
      testAction: { actionName: "crawl_list_active", input: {} },
    },
  ],
  homepageUrl: "https://github.com/firecrawl/firecrawl",
  actions: firecrawlLocalActions,
};

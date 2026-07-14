import type { ProviderDefinition } from "../../core/types.ts";

import { redmineActions } from "./actions.ts";

const service = "redmine";

/**
 * Redmine provider backed by a user-configured Redmine instance.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Redmine",
  categories: ["Developer Tools", "Productivity"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "REST API Key",
      placeholder: "0123456789abcdef0123456789abcdef01234567",
      description:
        "Redmine REST API access key. Find it under My account > API access key on your Redmine instance. An administrator must enable REST API access under Administration > Settings > API.",
      extraFields: [
        {
          key: "baseUrl",
          label: "Base URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://redmine.example.com",
          description:
            "Redmine instance base URL, including any sub-path such as https://redmine.example.com or https://example.com/redmine.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.redmine.org/",
  actions: redmineActions,
};

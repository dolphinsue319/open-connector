import type { ProviderDefinition } from "../../core/types.ts";

import { zeaburActions } from "./actions.ts";

const service = "zeabur";

export const provider: ProviderDefinition = {
  service,
  displayName: "Zeabur",
  categories: ["Developer Tools"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Token",
      placeholder: "sk-...",
      description:
        "Zeabur API key from Dashboard > Settings > API Keys. Sent as `Authorization: Bearer <apiKey>` to https://api.zeabur.com/graphql.",
      extraFields: [],
    },
  ],
  homepageUrl: "https://zeabur.com",
  actions: zeaburActions,
};

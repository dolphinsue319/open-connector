import type { ProviderDefinition } from "../../core/types.ts";

import { evermemActions } from "./actions.ts";

const service = "evermem";

/**
 * EverMem provider backed by a self-hosted EverOS long-term-memory instance.
 * EverOS ships no authentication of its own; the bearer token entered here is
 * enforced by the reverse proxy in front of it and sent as
 * `Authorization: Bearer <token>`.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "EverMem",
  categories: ["Productivity", "Developer Tools"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Bearer Token",
      placeholder: "your-everos-gateway-bearer-token",
      description:
        "Bearer token accepted by the gateway in front of your EverOS instance. Sent as `Authorization: Bearer <token>`. EverOS itself ships no built-in authentication.",
      extraFields: [
        {
          key: "baseUrl",
          label: "Base URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://evercore.example.com",
          description:
            "EverOS instance base URL, for example https://evercore.example.com. Must be https. Any sub-path is preserved.",
        },
      ],
    },
  ],
  actions: evermemActions,
};

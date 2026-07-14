import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { EvermemActionContext } from "./runtime.ts";

import { defineProviderExecutors, requireApiKeyCredential } from "../provider-runtime.ts";
import { evermemActionHandlers, resolveEvermemBaseUrl, validateEvermemCredential } from "./runtime.ts";

const service = "evermem";

export const executors: ProviderExecutors = defineProviderExecutors<EvermemActionContext>({
  service,
  handlers: evermemActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<EvermemActionContext> {
    const credential = await requireApiKeyCredential(context, service);
    return {
      apiKey: credential.apiKey,
      baseUrl: resolveEvermemBaseUrl({
        values: credential.values,
        metadata: credential.metadata,
      }),
      fetcher,
      signal: context.signal,
    };
  },
  fallbackMessage: "EverMem request failed.",
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    return validateEvermemCredential(input, fetcher, signal);
  },
};

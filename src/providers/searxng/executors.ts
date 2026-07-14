import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { SearxngActionContext } from "./runtime.ts";

import { defineProviderExecutors, requireCustomCredential } from "../provider-runtime.ts";
import { resolveSearxngBaseUrl, searxngActionHandlers, validateSearxngCredential } from "./runtime.ts";

const service = "searxng";

export const executors: ProviderExecutors = defineProviderExecutors<SearxngActionContext>({
  service,
  handlers: searxngActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<SearxngActionContext> {
    const credential = await requireCustomCredential(context, service);
    return {
      baseUrl: resolveSearxngBaseUrl({ values: credential.values, metadata: credential.metadata }),
      fetcher,
      signal: context.signal,
    };
  },
  fallbackMessage: "SearXNG request failed.",
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }) {
    return validateSearxngCredential(input, fetcher, signal);
  },
};

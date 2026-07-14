import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { FirecrawlLocalActionContext } from "./runtime.ts";

import { defineProviderExecutors, requireCustomCredential } from "../provider-runtime.ts";
import {
  firecrawlLocalActionHandlers,
  resolveFirecrawlLocalBaseUrl,
  validateFirecrawlLocalCredential,
} from "./runtime.ts";

const service = "firecrawl_local";

export const executors: ProviderExecutors = defineProviderExecutors<FirecrawlLocalActionContext>({
  service,
  handlers: firecrawlLocalActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<FirecrawlLocalActionContext> {
    const credential = await requireCustomCredential(context, service);
    return {
      baseUrl: resolveFirecrawlLocalBaseUrl({ values: credential.values, metadata: credential.metadata }),
      fetcher,
      signal: context.signal,
    };
  },
  fallbackMessage: "Firecrawl request failed.",
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }) {
    return validateFirecrawlLocalCredential(input, fetcher, signal);
  },
};

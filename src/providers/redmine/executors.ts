import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { RedmineActionContext } from "./runtime.ts";

import { defineProviderExecutors, requireApiKeyCredential } from "../provider-runtime.ts";
import { redmineActionHandlers, resolveRedmineBaseUrl, validateRedmineCredential } from "./runtime.ts";

const service = "redmine";

export const executors: ProviderExecutors = defineProviderExecutors<RedmineActionContext>({
  service,
  handlers: redmineActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<RedmineActionContext> {
    const credential = await requireApiKeyCredential(context, service);
    return {
      apiKey: credential.apiKey,
      baseUrl: resolveRedmineBaseUrl({
        values: credential.values,
        metadata: credential.metadata,
      }),
      fetcher,
      signal: context.signal,
    };
  },
  fallbackMessage: "Redmine request failed.",
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    return validateRedmineCredential(input, fetcher, signal);
  },
};

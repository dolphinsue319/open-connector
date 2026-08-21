import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { RedmineActionContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireApiKeyCredential } from "../provider-runtime.ts";
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
  // Self-hosted target (host.docker.internal / tailnet / LAN): upstream now
  // guards provider egress, so the deployment opt-in must be forwarded.
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    const guardedFetcher = createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: isPrivateNetworkAccessAllowed,
    });
    return validateRedmineCredential(input, guardedFetcher, signal);
  },
};

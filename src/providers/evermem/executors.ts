import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { EvermemActionContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireApiKeyCredential } from "../provider-runtime.ts";
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
    return validateEvermemCredential(input, guardedFetcher, signal);
  },
};

import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { FirecrawlLocalActionContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireCustomCredential } from "../provider-runtime.ts";
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
  // Self-hosted target (host.docker.internal / tailnet / LAN): upstream now
  // guards provider egress, so the deployment opt-in must be forwarded.
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
  // OrbStack resolves host.docker.internal to 0.250.250.254, inside the
  // always-blocked 0.0.0.0/8 "this-network" range that neither the private
  // opt-in nor OOMOL_CONNECT_EGRESS_TRUSTED_HOSTS can reopen. The URL-level
  // guard still applies; only the resolved-address check is skipped.
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }) {
    const guardedFetcher = createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: isPrivateNetworkAccessAllowed,
      skipDnsValidation: true,
    });
    return validateFirecrawlLocalCredential(input, guardedFetcher, signal);
  },
};

import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { ComfyuiActionContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireCustomCredential } from "../provider-runtime.ts";
import { comfyuiActionHandlers, resolveComfyuiBaseUrl, validateComfyuiCredential } from "./runtime.ts";

const service = "comfyui";

export const executors: ProviderExecutors = defineProviderExecutors<ComfyuiActionContext>({
  service,
  handlers: comfyuiActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<ComfyuiActionContext> {
    const credential = await requireCustomCredential(context, service);
    return {
      baseUrl: resolveComfyuiBaseUrl({ values: credential.values, metadata: credential.metadata }),
      fetcher,
      signal: context.signal,
      // ComfyUI returns generated images, so the transit writer must be
      // forwarded into the action context (see openscad/executors.ts).
      transitFiles: context.transitFiles,
    };
  },
  fallbackMessage: "ComfyUI request failed.",
  // Self-hosted target (host.docker.internal / tailnet / LAN): upstream now
  // guards provider egress, so the deployment opt-in must be forwarded.
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
  // KNOWN EXCEPTION to the AGENTS.md egress rule ("never skip DNS validation
  // when the host comes from credential input"). OrbStack resolves
  // host.docker.internal to 0.250.250.254, inside the always-blocked 0.0.0.0/8
  // "this-network" range that neither the private opt-in nor
  // OOMOL_CONNECT_EGRESS_TRUSTED_HOSTS can reopen, so the local-Docker family
  // (comfyui, firecrawl_local, openscad, searxng) has no other way to reach its
  // own instance. The URL-level guard still applies; only the resolved-address
  // check is skipped.
  //
  // What that leaves open: a baseUrl hostname that DNS-resolves to a blocked
  // address (cloud metadata, loopback) is no longer caught, and this flag is NOT
  // gated by OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK. The residual risk is carried by
  // who may write a custom_credential: baseUrl arrives only through the
  // admin-scoped PUT /api/connections, never from an MCP/runtime-token caller, so
  // exercising this requires the operator's own credentials.
  //
  // Do NOT copy this pair into a provider that fetches user-supplied URLs. The
  // real fixes, when this becomes worth paying for: make skipDnsValidation accept
  // a host predicate so only host.docker.internal is exempt, or reach the
  // instance over a private LAN/tailnet IP (100.64/10 and RFC 1918 are class
  // "private" in core/request.ts, so the opt-in already covers them and this flag
  // can be dropped).
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }) {
    // Same egress policy as the action executors above, including the documented
    // skipDnsValidation exception — validation talks to the same instance host.
    const guardedFetcher = createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: isPrivateNetworkAccessAllowed,
      skipDnsValidation: true,
    });
    return validateComfyuiCredential(input, guardedFetcher, signal);
  },
};

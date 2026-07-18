import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { OpenscadActionContext } from "./runtime.ts";

import { defineProviderExecutors, requireCustomCredential } from "../provider-runtime.ts";
import { openscadActionHandlers, resolveOpenscadBaseUrl, validateOpenscadCredential } from "./runtime.ts";

const service = "openscad";

export const executors: ProviderExecutors = defineProviderExecutors<OpenscadActionContext>({
  service,
  handlers: openscadActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<OpenscadActionContext> {
    const credential = await requireCustomCredential(context, service);
    return {
      baseUrl: resolveOpenscadBaseUrl({ values: credential.values, metadata: credential.metadata }),
      fetcher,
      signal: context.signal,
      // Unlike searxng/firecrawl, openscad emits files, so the transit writer
      // must be forwarded into the action context (see bannerbear/executors.ts).
      transitFiles: context.transitFiles,
    };
  },
  fallbackMessage: "OpenSCAD request failed.",
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }) {
    return validateOpenscadCredential(input, fetcher, signal);
  },
};

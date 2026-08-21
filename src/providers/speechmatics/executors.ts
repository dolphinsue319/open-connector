import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { SpeechmaticsActionContext } from "./runtime.ts";

import { optionalString } from "../../core/cast.ts";
import { defineProviderExecutors, requireApiKeyCredential } from "../provider-runtime.ts";
import { speechmaticsActionHandlers, validateSpeechmaticsCredential } from "./runtime.ts";

const service = "speechmatics";

export const executors: ProviderExecutors = defineProviderExecutors<SpeechmaticsActionContext>({
  service,
  handlers: speechmaticsActionHandlers,
  async createContext(input, fetcher) {
    const credential = await requireApiKeyCredential(input, service);
    return {
      apiKey: credential.apiKey,
      defaultRegion:
        optionalString(credential.values.defaultRegion) ?? optionalString(credential.metadata.defaultRegion),
      fetcher,
      signal: input.signal,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validateSpeechmaticsCredential(
      { apiKey: input.apiKey, defaultRegion: optionalString(input.values.defaultRegion) },
      fetcher,
      signal,
    );
  },
};

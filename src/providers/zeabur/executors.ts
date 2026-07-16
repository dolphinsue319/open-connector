import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors } from "../provider-runtime.ts";
import { validateZeaburCredential, zeaburActionHandlers } from "./runtime.ts";

const service = "zeabur";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, zeaburActionHandlers);

export const credentialValidators: CredentialValidators = {
  apiKey: validateZeaburCredential,
};

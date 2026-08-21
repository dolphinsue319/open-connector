import type { ResolvedCredential } from "../core/types.ts";

/**
 * Credential factories for the fork-local provider tests.
 *
 * Upstream deleted `provider-proxy-loader.test-helpers.ts` when it ported the
 * providers to the hosted runtime (aef8d772). The self-hosted providers kept in
 * this fork still test their executors directly, so the two factories they used
 * live here instead.
 */
export function apiKeyCredential(apiKey: string, values: Record<string, string> = {}): ResolvedCredential {
  return {
    authType: "api_key",
    apiKey,
    values: { apiKey, ...values },
    profile: { accountId: "acct_1", displayName: "Test", grantedScopes: [] },
    metadata: values,
  };
}

export function customCredential(values: Record<string, string>): ResolvedCredential {
  return {
    authType: "custom_credential",
    values,
    profile: { accountId: "acct_1", displayName: "Test", grantedScopes: [] },
    metadata: values,
  };
}

import type { ScheduledTaskWebhookEndpoint } from "@lecturn/contracts";
import { isLocalLoopbackHost } from "@lecturn/shared/hostClassification";

export interface WebhookAddress {
  readonly address: string;
  readonly copyable: boolean;
  /** One line on who can reach `address`; null for a Lecturn Connect URL. */
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
): WebhookAddress {
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: "Link this environment to Lecturn Connect for a public URL.",
    };
  }
  const url = new URL(endpoint.path, httpBaseUrl);
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? "Only this computer can call this address. Link Lecturn Connect for a public URL."
      : "Works wherever this environment's address is reachable, for example over Tailscale or your own proxy. Link Lecturn Connect for a public URL.",
  };
}

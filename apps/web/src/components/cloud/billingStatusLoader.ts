import type { RelayBillingStatus } from "@t3tools/contracts";

/** Account changes and overlapping refreshes must not publish an older request's result. */
export function createBillingStatusLoader(
  client: {
    getStatus: () => Promise<RelayBillingStatus>;
    reconcile: (sessionId: string) => Promise<RelayBillingStatus>;
  },
  publish: { status: (status: RelayBillingStatus) => void; error: () => void },
) {
  let generation = 0;
  let disposed = false;
  return {
    async refresh(sessionId?: string) {
      const request = ++generation;
      try {
        const status = await (sessionId ? client.reconcile(sessionId) : client.getStatus());
        if (!disposed && generation === request) publish.status(status);
      } catch {
        if (!disposed && generation === request) publish.error();
      }
    },
    dispose() {
      disposed = true;
      generation++;
    },
  };
}

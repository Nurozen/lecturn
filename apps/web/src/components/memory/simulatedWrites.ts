import type { MemoryWriteInput, ProjectId } from "@lecturn/contracts";

/** Canned facts for "Simulate agent write", the demo fallback when no agent is live. */
export const SIMULATED_MEMORY_WRITES: ReadonlyArray<Omit<MemoryWriteInput, "projectId">> = [
  {
    summary:
      "Stripe retries failed webhooks with exponential backoff for up to 3 days, so handlers must tolerate replays hours later.",
    context:
      "A 5xx or timeout from our endpoint schedules a retry; the same event.id can arrive long after the first attempt.",
    type: "concept",
    tags: ["stripe", "webhooks", "retries"],
    sourcePath: "src/billing/webhooks.ts",
  },
  {
    summary:
      "Charge and refund calls send an idempotency key derived from the order id; never mint a random key per retry.",
    context: "A fresh key per retry turned one network blip into a double charge.",
    type: "decision",
    tags: ["stripe", "idempotency", "billing"],
    sourcePath: "src/billing/stripeClient.ts",
  },
  {
    summary:
      "Migrations are append-only: never edit a merged migration, add a new one that fixes forward.",
    context: "Deployed databases have already run the old file, so edits silently diverge schemas.",
    type: "decision",
    tags: ["migrations", "database"],
    sourcePath: "db/migrations",
  },
];

let nextSimulatedWrite = 0;

/** Rotates through the canned facts so repeated clicks write distinct nodes. */
export function nextSimulatedMemoryWrite(projectId: ProjectId): MemoryWriteInput {
  const fact = SIMULATED_MEMORY_WRITES[nextSimulatedWrite % SIMULATED_MEMORY_WRITES.length]!;
  nextSimulatedWrite += 1;
  return { ...fact, projectId };
}

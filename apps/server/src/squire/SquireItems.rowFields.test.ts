import { assert, describe, it } from "@effect/vitest";

import { squireCardRowFields } from "./SquireItems.ts";
import type * as SquireRepository from "./SquireRepository.ts";

const overlapRow = (payload: unknown) =>
  ({
    id: "card:overlap:1",
    squire_id: "lead",
    owner_squire_id: "release",
    kind: "overlap",
    status: "open",
    target_thread_id: null,
    project_id: "project-billing",
    title: "Overlap: Fix invoice rounding and Currency display cleanup",
    payload_json: JSON.stringify(payload),
    origin: "event",
    steer_kind: null,
    rule_id: null,
    routed_task_id: null,
    replaced_count: 0,
    executes_at: null,
    opened_at: null,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
  }) as unknown as SquireRepository.SquireCardRow;

describe("squireCardRowFields", () => {
  it("names a voice card's speaker check, and no other card's (D33)", () => {
    const steer = (origin: string, trigger: unknown) =>
      ({
        ...(overlapRow({}) as unknown as Record<string, unknown>),
        kind: "steer",
        payload_json: "{}",
        origin,
        trigger_json: JSON.stringify(trigger),
      }) as unknown as SquireRepository.SquireCardRow;
    assert.strictEqual(
      squireCardRowFields(steer("voice", { speakerVerified: false })).speakerVerified,
      false,
    );
    assert.strictEqual(
      squireCardRowFields(steer("voice", { speakerVerified: true })).speakerVerified,
      true,
    );
    // A voice card raised before the check was recorded, or an event turn's update of one.
    assert.notProperty(squireCardRowFields(steer("voice", {})), "speakerVerified");
    assert.notProperty(
      squireCardRowFields(steer("event", { speakerVerified: false })),
      "speakerVerified",
    );
  });

  it("gives an overlap row its threads' providers and Squires, so the row needs no card read", () => {
    const fields: Record<string, unknown> = squireCardRowFields(
      overlapRow({
        type: "overlap",
        repository: "project-billing",
        threads: [
          { threadId: "a", squireId: "release", branch: null, provider: "claudeAgent" },
          { threadId: "b", squireId: "research", branch: "fix/x", provider: "codex" },
        ],
        paths: ["src/invoice/InvoiceTotals.ts"],
        recommendation: "Land #321 first",
      }),
    );
    assert.deepEqual(fields["overlapProviders"], ["claudeAgent", "codex"]);
    assert.deepEqual(fields["relatedSquireIds"], ["release", "research"]);
    // Cards raised before instances were recorded leave the row to the drivers.
    assert.notProperty(fields, "overlapProviderInstanceIds");
  });

  it("gives an overlap row each thread's provider instance, null where none was recorded", () => {
    const fields: Record<string, unknown> = squireCardRowFields(
      overlapRow({
        type: "overlap",
        repository: "project-billing",
        threads: [
          {
            threadId: "a",
            squireId: "release",
            branch: null,
            provider: "scripted",
            providerInstanceId: "scripted",
          },
          { threadId: "b", squireId: "research", branch: null, provider: "codex" },
        ],
        paths: ["src/invoice/InvoiceTotals.ts"],
        recommendation: "Land #321 first",
      }),
    );
    assert.deepEqual(fields["overlapProviders"], ["scripted", "codex"]);
    assert.deepEqual(fields["overlapProviderInstanceIds"], ["scripted", null]);
  });

  it("gives a question row its request's time, so its age counts from the ask", () => {
    const row = (payload: unknown) =>
      ({
        ...(overlapRow(payload) as unknown as Record<string, unknown>),
        id: "card:question:1",
        kind: "question",
        target_thread_id: "thread-plan",
        created_at: "2026-11-01T10:45:00.000Z",
      }) as unknown as SquireRepository.SquireCardRow;
    const base = { type: "question", threadId: "thread-plan", requestKind: "runtime" };
    const fields: Record<string, unknown> = squireCardRowFields(
      row({ ...base, requestId: "req-1", requestedAt: "2026-11-01T10:00:00.000Z" }),
    );
    assert.strictEqual(fields["requestedAt"], "2026-11-01T10:00:00.000Z");
    // Cards raised before the time was recorded fall back to the card's own age.
    assert.notProperty(squireCardRowFields(row({ ...base, requestId: "req-2" })), "requestedAt");
  });
});

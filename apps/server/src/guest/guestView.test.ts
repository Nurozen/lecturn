import { describe, expect, it } from "@effect/vitest";
import { OrchestrationV2AppThread, type OrchestrationV2DomainEvent } from "@lecturn/contracts";

import {
  GUEST_THREAD_FIELDS,
  guestDomainEvent,
  guestThread,
  guestThreadModel,
} from "./guestView.ts";

// Lecturn: what the fork adds to the thread record. Sharing one more needs a decision here.
// Upstream's link fields name the owner's other machines and link sessions, so guests
// do not get them either.
const FORK_THREAD_FIELDS = [
  "appData",
  "appOrigin",
  "appSubtitle",
  "continuedIn",
  "copiedFrom",
  "delegatedFrom",
  "forkOrigin",
  "importedFrom",
  "linkOrigin",
  "opens",
  "squire",
];

describe("guestThread", () => {
  it("withholds every thread field outside the allowlist, and only those", () => {
    const allowed: ReadonlyArray<string> = GUEST_THREAD_FIELDS;
    expect(
      Object.keys(OrchestrationV2AppThread.fields)
        .filter((field) => !allowed.includes(field))
        .toSorted(),
    ).toEqual(FORK_THREAD_FIELDS);
  });

  it("strips a thread carrying every fork field down to upstream's record", () => {
    const thread = Object.fromEntries(
      Object.keys(OrchestrationV2AppThread.fields).map((field) => [field, `value:${field}`]),
    ) as unknown as OrchestrationV2AppThread;
    const shared = guestThread(thread);
    expect(Object.keys(shared).toSorted()).toEqual([...GUEST_THREAD_FIELDS].toSorted());
    for (const field of FORK_THREAD_FIELDS) expect(shared).not.toHaveProperty(field);
    expect(shared.title).toBe("value:title");

    const event = { type: "thread.visited", payload: thread } as OrchestrationV2DomainEvent;
    expect(Object.keys(guestDomainEvent(event).payload).toSorted()).toEqual(
      [...GUEST_THREAD_FIELDS].toSorted(),
    );
    const other = { type: "run.updated", payload: { id: "run-1" } } as OrchestrationV2DomainEvent;
    expect(guestDomainEvent(other)).toBe(other);
  });
});

describe("guestThreadModel", () => {
  const providers = [
    {
      instanceId: "claude-work",
      driver: "claudeAgent",
      models: [
        {
          slug: "claude-opus",
          name: "Claude Opus",
          shortName: "Opus",
          isCustom: false,
          capabilities: null,
        },
      ],
    },
  ] as unknown as Parameters<typeof guestThreadModel>[1];

  it("names the model as the owner's picker does, or by its id when it is not listed", () => {
    const selection = (instanceId: string, model: string) =>
      ({ instanceId, model }) as Parameters<typeof guestThreadModel>[0];
    expect(guestThreadModel(selection("claude-work", "claude-opus"), providers)).toEqual({
      driver: "claudeAgent",
      name: "Claude Opus",
      shortName: "Opus",
    });
    expect(guestThreadModel(selection("removed", "gpt-5"), providers)).toEqual({
      driver: null,
      name: "gpt-5",
    });
  });
});

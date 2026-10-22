import { assert, it } from "vite-plus/test";
import { ProjectId } from "@lecturn/contracts";
import { decisionSourceEvent } from "./DecisionSourceEvents.ts";
import {
  projectDeletedEvent,
  v2MessageEvent,
  v2RunEvent,
  v2ThreadEvent,
} from "./V2ProjectionTestFixtures.ts";

it("maps V2 application events onto decision source changes", () => {
  assert.deepEqual(decisionSourceEvent(v2MessageEvent(1, { threadId: "t", messageId: "m" })), {
    sequence: 1,
    kind: "message-final",
    threadId: "t",
    messageId: "m",
  } as never);
  assert.equal(
    decisionSourceEvent(v2MessageEvent(2, { threadId: "t", messageId: "m", streaming: true })).kind,
    "ignored",
  );
  assert.equal(
    decisionSourceEvent(v2MessageEvent(3, { threadId: "t", messageId: "m", role: "system" })).kind,
    "ignored",
  );
  const created = decisionSourceEvent(v2ThreadEvent(4, "thread.created", "t"));
  assert.equal(created.kind === "thread-generation" && created.reason, "created");
  const forked = decisionSourceEvent(v2ThreadEvent(5, "thread.created", "c", { fork: true }));
  assert.equal(forked.kind === "thread-generation" && forked.reason, "forked");
  const imported = decisionSourceEvent(v2ThreadEvent(6, "thread.imported", "t"));
  assert.equal(imported.kind === "thread-generation" && imported.reason, "imported");
  const reverted = decisionSourceEvent(v2RunEvent(7, "t", "r", "rolled_back"));
  assert.equal(reverted.kind === "thread-generation" && reverted.reason, "reverted");
  assert.equal(decisionSourceEvent(v2RunEvent(8, "t", "r", "completed")).kind, "ignored");
  assert.equal(decisionSourceEvent(v2ThreadEvent(9, "thread.deleted", "t")).kind, "thread-deleted");
  assert.equal(
    decisionSourceEvent(v2ThreadEvent(10, "thread.archived", "t")).kind,
    "thread-archived",
  );
  assert.equal(
    decisionSourceEvent(v2ThreadEvent(11, "thread.unarchived", "t")).kind,
    "thread-unarchived",
  );
  assert.deepEqual(decisionSourceEvent(projectDeletedEvent(12, ProjectId.make("p"))), {
    sequence: 12,
    kind: "project-deleted",
    projectId: "p",
  } as never);
});

it("ignores legacy-import re-materialization of V1 history", () => {
  for (const event of [
    v2ThreadEvent(1, "thread.created", "t", { eventId: "migration:v1:thread:t:created" }),
    v2MessageEvent(2, { threadId: "t", messageId: "m", eventId: "migration:v1:message:m" }),
  ])
    assert.equal(decisionSourceEvent(event).kind, "ignored");
});

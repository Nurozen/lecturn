import { SquireId } from "@lecturn/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resetSquireGesturesForTests, takeSquireGestures } from "./squireGesturePlayer";

afterEach(resetSquireGesturesForTests);

describe("takeSquireGestures", () => {
  it("greets on a Squire's first open and never again in the session", () => {
    const squireId = SquireId.make("release");
    expect(takeSquireGestures(squireId, [])).toEqual(["greet"]);
    expect(takeSquireGestures(squireId, [])).toEqual([]);
  });

  it("leaves the Lead's first-open greet to its onboarding", () => {
    const leadId = SquireId.make("lead");
    expect(takeSquireGestures(leadId, [], false)).toEqual([]);
    expect(
      takeSquireGestures(
        leadId,
        [
          {
            sequence: 1,
            kind: "event.received",
            at: "2026-11-01T10:00:00.000Z",
            gesture: "ponder",
          },
        ],
        false,
      ),
    ).toEqual(["ponder"]);
  });
});

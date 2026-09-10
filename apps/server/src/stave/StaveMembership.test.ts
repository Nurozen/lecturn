import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { StaveCli } from "./StaveCli.ts";
import { scanStaveMembership } from "./StaveMembership.ts";

const saga = {
  id: "release",
  logicalId: "release",
  path: "/spaces/release",
  isSaga: true,
  members: ["a", "b"],
};
describe("fresh saga membership", () => {
  it.effect("counts precisely the ordering edges removed with a member", () =>
    Effect.gen(function* () {
      const result = yield* scanStaveMembership("a");
      expect(result).toEqual({
        membershipUnknown: false,
        sagaMembership: {
          sagaId: "release",
          sagaRoot: "/spaces/release",
          dependentEdges: [{ memberId: "b", after: "a" }],
        },
      });
    }).pipe(
      Effect.provide(
        Layer.mock(StaveCli)({
          sagaList: Effect.succeed([saga]),
          sagaStatus: () =>
            Effect.succeed({
              sagaId: "release",
              notes: [],
              members: [
                { id: "a", after: [], state: "live", dirty: false, repos: [], prs: [] },
                { id: "b", after: ["a", "other"], state: "live", dirty: false, repos: [], prs: [] },
              ],
            }),
        }),
      ),
    ),
  );
  it.effect("refuses to assert non-membership when any saga is unreadable", () =>
    Effect.gen(function* () {
      const result = yield* scanStaveMembership("unrelated");
      expect(result.membershipUnknown).toBe(true);
      expect(result.sagaMembership).toBeNull();
    }).pipe(
      Effect.provide(
        Layer.mock(StaveCli)({
          sagaList: Effect.succeed([{ ...saga, error: "permission denied" }]),
        }),
      ),
    ),
  );
});

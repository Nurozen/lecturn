/** A fresh, fail-closed roster scan for delete confirmation and destructive admission. */
import type { StaveSagaMembership } from "@lecturn/contracts";
import { Effect } from "effect";
import { StaveCli } from "./StaveCli.ts";

export const scanStaveMembership = Effect.fn("scanStaveMembership")(function* (spaceId: string) {
  const cli = yield* StaveCli;
  return yield* Effect.gen(function* () {
    const sagas = yield* cli.sagaList;
    let membership: StaveSagaMembership | null = null;
    for (const saga of sagas) {
      if (saga.error) return { sagaMembership: null, membershipUnknown: true };
      if (!saga.isSaga) continue;
      const status = yield* cli.sagaStatus(saga.logicalId ?? saga.id);
      if (!status.members.some((member) => member.id === spaceId)) continue;
      if (membership !== null) return { sagaMembership: null, membershipUnknown: true };
      membership = {
        sagaId: status.sagaId,
        sagaRoot: saga.path,
        dependentEdges: status.members.flatMap((member) =>
          member.after
            .filter((after) => after === spaceId)
            .map((after) => ({ memberId: member.id, after })),
        ),
      };
    }
    return { sagaMembership: membership, membershipUnknown: false };
  }).pipe(Effect.orElseSucceed(() => ({ sagaMembership: null, membershipUnknown: true })));
});

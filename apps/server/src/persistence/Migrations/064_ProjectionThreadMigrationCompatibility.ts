import * as Effect from "effect/Effect";

import BranchPullRequest from "./048_ProjectionThreadBranchPullRequest.ts";
import ForkLineage from "./048_ProjectionThreadForkLineage.ts";

// Both products published migration 48 with different names and columns. The
// migrator skips IDs below the ledger's latest ID, so an upstream database skips
// ForkLineage and an existing Lecturn database skips BranchPullRequest. Reconcile
// both schemas additively without rewriting either installation's ledger.
export default Effect.gen(function* () {
  yield* ForkLineage;
  yield* BranchPullRequest;
});

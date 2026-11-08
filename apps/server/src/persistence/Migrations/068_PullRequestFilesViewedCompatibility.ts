import * as Effect from "effect/Effect";

import ImportOrigin from "./053_ProjectionThreadImportOrigin.ts";
import PullRequestFilesViewed from "./053_PullRequestFilesViewed.ts";

// Both products published migration 53 with different names and schemas, and the migrator skips IDs
// below the ledger's latest, so each side missed the other's. Both migrations only create what is
// missing, so run them again without rewriting either ledger.
export default Effect.gen(function* () {
  yield* ImportOrigin;
  yield* PullRequestFilesViewed;
});

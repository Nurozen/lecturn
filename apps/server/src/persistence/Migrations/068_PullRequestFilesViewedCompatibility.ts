import * as Effect from "effect/Effect";

import ImportOrigin from "./053_ProjectionThreadImportOrigin.ts";
import PullRequestFilesViewed from "./053_PullRequestFilesViewed.ts";

// Both products published migration 53 with different names and schemas. The
// migrator skips IDs below the ledger's latest ID, so an existing Lecturn database
// never ran upstream's viewed-files table, and an upstream database at 53 never ran
// Lecturn's thread import origin columns. Both migrations only create what is
// missing, so run them again without rewriting either installation's ledger.
export default Effect.gen(function* () {
  yield* ImportOrigin;
  yield* PullRequestFilesViewed;
});

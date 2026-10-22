import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectIconOverride, ProjectScript } from "./project.ts";
import { StaveProjectInfo, StaveProjectNotice } from "./stave.ts";

/** Project summary shared by the V2 shell and application project APIs. */
export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  // Per-project override for where new threads start. Null/absent means
  // "no override": clients fall back to lecturn.json, then the global setting.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Opt-in because background sync performs network I/O and may move the checkout.
  // Optional on the wire so cached snapshots from older servers still decode.
  autoPull: Schema.optional(Schema.Boolean),
  // Optional on the wire so cached snapshots from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  // Lecturn: Stave space attached to this project, and any lifecycle notice
  // for it. Optional on the wire so payloads from pre-Stave servers still
  // decode; null means "not a Stave space".
  stave: Schema.optional(Schema.NullOr(StaveProjectInfo)),
  notice: Schema.optional(Schema.NullOr(StaveProjectNotice)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

/**
 * Binds the Stave space identity a project deletion consents to (V1
 * Normalizer `project.delete` binding). The lifecycle journal only cleans up a
 * space whose manifest still carries this exact incarnation, so the identity
 * must be read fresh at delete time, never from a cache.
 *
 * Without a `StaveWorkspaceReader` (Stave not wired) or a manifest, the
 * deletion binds nothing and the journal treats the root as not a space.
 *
 * @module StaveDeletionIdentity
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";

export interface StaveDeletionIdentity {
  readonly staveSpaceId?: string;
  readonly staveCreatedAt?: string;
}

export const bindStaveDeletionIdentity = Effect.fn("StaveDeletionIdentity.bind")(function* (
  workspaceRoot: string,
) {
  const reader = yield* Effect.serviceOption(StaveWorkspaceReader);
  if (Option.isNone(reader)) return {} satisfies StaveDeletionIdentity;
  yield* reader.value.invalidate(workspaceRoot);
  const space = yield* reader.value.load(workspaceRoot);
  if (Option.isNone(space)) return {} satisfies StaveDeletionIdentity;
  return {
    staveSpaceId: space.value.spaceId,
    ...(space.value.createdAt === undefined ? {} : { staveCreatedAt: space.value.createdAt }),
  } satisfies StaveDeletionIdentity;
});

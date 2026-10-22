/**
 * Lecturn Stave adapters for the V2 project read/delete paths.
 *
 * V1 attached Stave `stave` / `notice` fields to project shells in
 * ProjectionSnapshotQuery and bound the space identity of a project deletion
 * in the Normalizer. On V2 both are optional services resolved once at
 * construction: without Stave wired (focused upstream tests) shells pass
 * through unchanged and deletions bind nothing beyond what the caller sent.
 *
 * @module StaveProjectShellDecoration
 */
import type { OrchestrationProjectShell } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { bindStaveDeletionIdentity } from "../../stave/StaveDeletionIdentity.ts";
import { StaveProjectShells } from "../../stave/StaveProjectShells.ts";
import { StaveWorkspaceReader } from "../../stave/StaveWorkspaceReader.ts";
import type { ProjectDeleteStaveFields } from "../ProjectCommands.ts";

export type ProjectShellDecorator = (
  shells: ReadonlyArray<OrchestrationProjectShell>,
) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>>;

/** Attach Stave `stave` / `notice` to shells sent to clients; identity when Stave is absent. */
export const resolveProjectShellDecorator: Effect.Effect<ProjectShellDecorator> = Effect.map(
  Effect.serviceOption(StaveProjectShells),
  Option.match({
    onNone: (): ProjectShellDecorator => Effect.succeed,
    onSome: (service): ProjectShellDecorator => service.decorate,
  }),
);

export type DeletionIdentityBinder = (
  workspaceRoot: string,
  requested: ProjectDeleteStaveFields | undefined,
) => Effect.Effect<ProjectDeleteStaveFields | undefined>;

/**
 * Bind the Stave space identity a deletion consents to. With a workspace
 * reader the identity is read fresh from the manifest and is authoritative
 * (caller-supplied ids are dropped); the client's saga confirm/teardown pass
 * through. Without a reader the caller's fields pass through unchanged.
 */
export const resolveDeletionIdentityBinder: Effect.Effect<DeletionIdentityBinder> = Effect.map(
  Effect.serviceOption(StaveWorkspaceReader),
  Option.match({
    onNone: (): DeletionIdentityBinder => (_root, requested) => Effect.succeed(requested),
    onSome:
      (reader): DeletionIdentityBinder =>
      (workspaceRoot, requested) =>
        bindStaveDeletionIdentity(workspaceRoot).pipe(
          Effect.provideService(StaveWorkspaceReader, reader),
          Effect.map((identity) => {
            const bound: ProjectDeleteStaveFields = {
              ...(requested?.staveSagaRemoveConfirmed === undefined
                ? {}
                : { staveSagaRemoveConfirmed: requested.staveSagaRemoveConfirmed }),
              ...(requested?.staveSagaTeardown === undefined
                ? {}
                : { staveSagaTeardown: requested.staveSagaTeardown }),
              ...identity,
            };
            return Object.keys(bound).length === 0 ? undefined : bound;
          }),
        ),
  }),
);

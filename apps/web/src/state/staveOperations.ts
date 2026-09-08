import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import { waitForProjectVisible } from "@t3tools/client-runtime/state/shell";
import { createStaveOperationManager } from "@t3tools/client-runtime/state/stave-operation";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell } from "./shell";

/**
 * Web binding of the streamed Stave operation consumer: one state atom per
 * operation id, a start-or-attach `run` command and a `reattach` command for
 * after a reconnect. The wizard's progress step reads
 * `staveOperations.stateAtom(operationId)`.
 */
export const staveOperations = createStaveOperationManager(connectionAtomRuntime);

export interface WaitForStaveProjectInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The shell sequence the server-side `project.create` produced. */
  readonly sequence: number;
}

/**
 * `createSpace` creates the project server-side and reports `{ projectId,
 * sequence }`; the project is opened only once this environment's shell has
 * applied that sequence (deviation 26).
 */
export const waitForStaveProjectVisible = createRuntimeCommand(connectionAtomRuntime, {
  label: "stave-operation:wait-for-project",
  execute: (input: WaitForStaveProjectInput, registry) =>
    waitForProjectVisible({
      registry,
      stateAtom: environmentShell.stateValueAtom(input.environmentId),
      projectId: input.projectId,
      sequence: input.sequence,
    }),
});

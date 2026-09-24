import { createThreadDecisionEnvironmentAtoms } from "@lecturn/client-runtime/state/threadDecisions";
import { connectionAtomRuntime } from "../connection/runtime";

export const threadDecisionEnvironment =
  createThreadDecisionEnvironmentAtoms(connectionAtomRuntime);

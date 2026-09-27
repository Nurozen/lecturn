import { createContextualEnvironmentAtoms } from "@lecturn/client-runtime/state/contextual";
import { connectionAtomRuntime } from "../connection/runtime";

export const contextualEnvironment = createContextualEnvironmentAtoms(connectionAtomRuntime);

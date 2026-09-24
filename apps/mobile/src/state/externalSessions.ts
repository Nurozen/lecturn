import { createExternalSessionsEnvironmentAtoms } from "@lecturn/client-runtime/state/externalSessions";

import { connectionAtomRuntime } from "../connection/runtime";

export const externalSessionsEnvironment =
  createExternalSessionsEnvironmentAtoms(connectionAtomRuntime);

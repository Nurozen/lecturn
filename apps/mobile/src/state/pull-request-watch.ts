import { createPullRequestWatchEnvironmentAtoms } from "@lecturn/client-runtime/state/pullRequestWatch";
import { connectionAtomRuntime } from "../connection/runtime";

export const pullRequestWatchEnvironment =
  createPullRequestWatchEnvironmentAtoms(connectionAtomRuntime);

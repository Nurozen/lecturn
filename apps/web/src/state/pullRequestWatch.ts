import { useAtomValue } from "@effect/atom-react";
import { createPullRequestWatchEnvironmentAtoms } from "@lecturn/client-runtime/state/pullRequestWatch";
import type { EnvironmentId, PullRequestWatchSnapshot } from "@lecturn/contracts";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { formatEnvironmentQueryError } from "./query";

export const pullRequestWatchEnvironment =
  createPullRequestWatchEnvironmentAtoms(connectionAtomRuntime);
const merged = Atom.family((key: string) =>
  Atom.make((get) => {
    const environments = JSON.parse(key) as EnvironmentId[];
    const values: Array<readonly [EnvironmentId, PullRequestWatchSnapshot]> = [];
    const errors: string[] = [];
    const failedEnvironmentIds: EnvironmentId[] = [];
    for (const environmentId of environments) {
      const result = get(pullRequestWatchEnvironment.list({ environmentId, input: {} }));
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value) values.push([environmentId, value]);
      if (result._tag === "Failure") {
        errors.push(formatEnvironmentQueryError(result.cause));
        failedEnvironmentIds.push(environmentId);
      }
    }
    return { values, errors, failedEnvironmentIds };
  }),
);

export function usePullRequestWatches(environmentIds: readonly EnvironmentId[]) {
  return useAtomValue(merged(JSON.stringify([...new Set(environmentIds)].sort())));
}

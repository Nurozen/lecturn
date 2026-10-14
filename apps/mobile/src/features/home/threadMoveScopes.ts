import type { SagaProjectIndexEntry } from "@lecturn/client-runtime/state/project-grouping";
import type { HomeThreadGroup } from "./homeThreadList";
import { hierarchyGroups } from "./homeListItems";
import { scopedProjectKey } from "../../lib/scopedEntities";

/** The rendered hierarchy's ownership, without its visibility filters. */
export function threadMoveScopes(
  groups: readonly HomeThreadGroup[],
  sagaIndex: readonly SagaProjectIndexEntry[],
) {
  return new Map(
    hierarchyGroups(groups, sagaIndex).flatMap((group) => {
      const refs =
        group.projectRefs ??
        group.projects.map((project) => ({
          environmentId: project.environmentId,
          projectId: project.id,
        }));
      const keys = refs.map((ref) => scopedProjectKey(ref.environmentId, ref.projectId)).sort();
      return keys.map((key) => [key, keys] as const);
    }),
  );
}

import { withoutArchivedStaveProjects } from "@lecturn/client-runtime/state/stave-archive";
import { useMemo } from "react";

import { useProjects } from "../../state/entities";
import { archivedStaveProjectKeys } from "./listedProjects.logic";

/**
 * The projects list surfaces offer: every project except archived Stave
 * spaces, plus the keys of those hidden projects so their threads can be
 * left out too.
 */
export function useListedProjects() {
  const allProjects = useProjects();
  return useMemo(
    () => ({
      projects: withoutArchivedStaveProjects(allProjects),
      archivedProjectKeys: archivedStaveProjectKeys(allProjects),
    }),
    [allProjects],
  );
}

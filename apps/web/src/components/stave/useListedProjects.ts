import { projectsForProjectsMode } from "@lecturn/client-runtime/state/app-projects";

import { useProjects } from "../../state/entities";
import { appProjectKeys, archivedStaveProjectKeys } from "./listedProjects.logic";

/**
 * The projects Projects-mode surfaces offer: every project except archived
 * Stave spaces and connected-app projects, plus the keys of each hidden kind.
 * Archived keys hide threads everywhere; app keys hide them only from
 * Projects-mode lists, since search and the palette keep app threads.
 */
export function useListedProjects() {
  const allProjects = useProjects();
  return {
    projects: projectsForProjectsMode(allProjects),
    archivedProjectKeys: archivedStaveProjectKeys(allProjects),
    appProjectKeys: appProjectKeys(allProjects),
  };
}

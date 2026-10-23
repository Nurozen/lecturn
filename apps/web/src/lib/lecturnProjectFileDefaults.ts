import {
  LECTURN_PROJECT_FILE_NAME,
  type EnvironmentId,
  type LecturnProjectFile,
} from "@lecturn/contracts";
import { parseLecturnProjectFile } from "@lecturn/shared/lecturnProjectFile";
import { executeAtomQuery } from "@lecturn/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export async function readLecturnProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<LecturnProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, LECTURN_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    LECTURN_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseLecturnProjectFile(data.contents);
}

import {
  LECTURN_PROJECT_FILE_NAME,
  type EnvironmentId,
  type LecturnProjectFile,
  type LecturnProjectFileScript,
} from "@lecturn/contracts";
import { parseLecturnProjectFile } from "@lecturn/shared/lecturnProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<LecturnProjectFileScript> = [];

export interface LecturnProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: LecturnProjectFile | null;
  scripts: ReadonlyArray<LecturnProjectFileScript>;
}

export function useLecturnProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): LecturnProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    LECTURN_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseLecturnProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

export function useLecturnProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<LecturnProjectFileScript> {
  return useLecturnProjectFileState(environmentId, cwd).scripts;
}

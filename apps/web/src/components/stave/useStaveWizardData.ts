import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { staveMemoryProviders, staveRepos, staveSagas, staveSpaces } from "../../state/stave";
import { memoryAvailableFrom, type StaveWizardContext } from "./staveSpaceWizard.logic";

const EMPTY: ReadonlyArray<never> = [];

export interface StaveWizardData {
  readonly context: StaveWizardContext;
  /** Any of the four reads is still in flight. */
  readonly isPending: boolean;
  /** The first read failure, for the dialog to show inline. */
  readonly error: string | null;
  refreshRepos: () => void;
  refreshSpaces: () => void;
}

/**
 * The registry, spaces (live + archived), sagas and memory providers the
 * wizard validates against, folded into one `StaveWizardContext`. Passing
 * `null` renders an empty context without touching the environment.
 */
export function useStaveWizardData(environmentId: EnvironmentId | null): StaveWizardData {
  const repos = useEnvironmentQuery(
    environmentId === null ? null : staveRepos({ environmentId, input: {} }),
  );
  const spaces = useEnvironmentQuery(
    environmentId === null
      ? null
      : staveSpaces({ environmentId, input: { includeArchived: true } }),
  );
  const sagas = useEnvironmentQuery(
    environmentId === null ? null : staveSagas({ environmentId, input: {} }),
  );
  const providers = useEnvironmentQuery(
    environmentId === null ? null : staveMemoryProviders({ environmentId, input: {} }),
  );

  const repoRows = repos.data ?? EMPTY;
  const spaceRows = spaces.data ?? EMPTY;
  const sagaRows = sagas.data ?? EMPTY;
  const memoryAvailable = memoryAvailableFrom(providers.data);
  const context = useMemo<StaveWizardContext>(
    () => ({ repos: repoRows, spaces: spaceRows, sagas: sagaRows, memoryAvailable }),
    [memoryAvailable, repoRows, sagaRows, spaceRows],
  );

  return {
    context,
    isPending: repos.isPending || spaces.isPending || sagas.isPending || providers.isPending,
    error: repos.error ?? spaces.error ?? sagas.error ?? providers.error,
    refreshRepos: repos.refresh,
    refreshSpaces: spaces.refresh,
  };
}

import type { EnvironmentId } from "@lecturn/contracts";
import { useEffect, useMemo, useState } from "react";

import {
  type ExternalSessionsInstanceResult,
  IMPORT_SESSION_LIST_LIMIT,
  listImportCapableProviders,
  mergeExternalSessionResults,
} from "../components/ImportSessionPalette.logic";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { readEnvironmentProviders, readEnvironmentSupportsForking } from "../state/entities";
import { externalSessionsEnvironment } from "../state/externalSessions";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

export type MergedExternalSessions = ReturnType<typeof mergeExternalSessionResults>;

/**
 * Lists every import-capable instance's sessions once per (environment, cwd),
 * merged newest first. A null `cwd` lists every folder; a null
 * `environmentId` keeps the hook idle, so nothing is fetched until a flow
 * opens. No search term reaches the server: callers filter client-side.
 */
export function useExternalSessionList(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}): {
  readonly merged: MergedExternalSessions | null;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly isLoading: boolean;
} {
  const { cwd, environmentId } = input;
  const listSessions = useAtomQueryRunner(externalSessionsEnvironment.list, {
    reportFailure: false,
    reportDefect: false,
  });
  const providerEntries = useMemo(
    () =>
      environmentId === null
        ? []
        : deriveProviderInstanceEntries(
            listImportCapableProviders({
              supportsForking: readEnvironmentSupportsForking(environmentId),
              providers: readEnvironmentProviders(environmentId),
            }),
          ),
    [environmentId],
  );
  const requestKey =
    environmentId === null
      ? null
      : JSON.stringify([environmentId, cwd, providerEntries.map((entry) => entry.instanceId)]);
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly merged: MergedExternalSessions;
  } | null>(null);

  useEffect(() => {
    if (requestKey === null || environmentId === null) return;
    let cancelled = false;
    void Promise.all(
      providerEntries.map(async (entry): Promise<ExternalSessionsInstanceResult> => {
        const providerInstanceId = entry.instanceId;
        try {
          const result = await listSessions({
            environmentId,
            input: {
              providerInstanceId,
              ...(cwd === null ? {} : { cwd }),
              limit: IMPORT_SESSION_LIST_LIMIT,
            },
          });
          return result._tag === "Success"
            ? { providerInstanceId, ok: true, ...result.value }
            : { providerInstanceId, ok: false };
        } catch {
          return { providerInstanceId, ok: false };
        }
      }),
    ).then((results) => {
      if (!cancelled) {
        setLoaded({ key: requestKey, merged: mergeExternalSessionResults(results) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, environmentId, listSessions, providerEntries, requestKey]);

  const merged = loaded !== null && loaded.key === requestKey ? loaded.merged : null;
  return { merged, providerEntries, isLoading: requestKey !== null && merged === null };
}

/** Notes for listing failures and truncation, shared by every list built on this hook. */
export function externalSessionListNotes(input: {
  readonly merged: MergedExternalSessions;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly truncatedNote: string;
}): ReadonlyArray<string> {
  const failedNames = input.merged.failedInstanceIds.map(
    (instanceId) =>
      input.providerEntries.find((entry) => entry.instanceId === instanceId)?.displayName ??
      instanceId,
  );
  return [
    ...failedNames.map((name) => `Could not load sessions from ${name}.`),
    ...(input.merged.truncated ? [input.truncatedNote] : []),
  ];
}

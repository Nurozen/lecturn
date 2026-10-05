import { useEffect, useMemo, useRef } from "react";
import type { SagaProjectIndexEntry } from "@lecturn/client-runtime/state/project-grouping";
import type { RepositoryScopeProject } from "@lecturn/client-runtime/state/repositoryScope";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@lecturn/client-runtime/state/runtime";
import {
  environmentSupportsStave,
  staveFeatureAvailable,
} from "@lecturn/client-runtime/state/stave";
import { type EnvironmentId, type StaveSpaceStatus, WS_METHODS } from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { type EnvironmentQueryView, useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { subscribeStaveMutation } from "../staveMutation";
import { appAtomRegistry } from "../rpc/atomRegistry";

/**
 * Web Stave reads. Mobile has its own query binding to the shared RPC contracts.
 */

/** Live binary/config/marmot probe. 15s stale window matches the server-side
    memo so a settings-page refresh is never answered from a stale cache. */
export const staveStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:stave:status",
  tag: WS_METHODS.staveGetStatus,
  staleTimeMs: 15_000,
});

/** Per-space drift (ahead/behind/dirty) and memory freshness. */
export const staveSpaceStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:stave:space-status",
  tag: WS_METHODS.staveSpaceStatus,
  staleTimeMs: 15_000,
});

export const staveSagaStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:stave:saga-status",
  tag: WS_METHODS.staveSagaStatus,
  staleTimeMs: 15_000,
});

const sagaRepositoryIndex = Atom.family((key: string) =>
  Atom.make((get) => {
    const targets = JSON.parse(key) as Array<{ environmentId: EnvironmentId; sagaRoot: string }>;
    const entries: SagaProjectIndexEntry[] = [];
    for (const target of targets) {
      const config = get(serverEnvironment.configValueAtom(target.environmentId));
      if (!environmentSupportsStave(config) || !config?.settings.stave.enabled) continue;
      const result = get(
        staveSagaStatus({
          environmentId: target.environmentId,
          input: { sagaRoot: target.sagaRoot },
        }),
      );
      if (AsyncResult.isSuccess(result)) entries.push({ ...target, status: result.value });
    }
    return entries;
  }),
);

/** Repository ownership uses verified rosters independently of sidebar nesting preferences. */
export function useSagaRepositoryIndex(projects: readonly RepositoryScopeProject[]) {
  const key = useMemo(
    () =>
      JSON.stringify(
        projects
          .filter((project) => project.stave?.isSaga && project.stave.state !== "archived")
          .map((project) => ({
            environmentId: project.environmentId,
            sagaRoot: project.workspaceRoot,
          })),
      ),
    [projects],
  );
  const entries = useAtomValue(sagaRepositoryIndex(key));
  useEffect(
    () =>
      subscribeStaveMutation((environmentId) => {
        const targets = JSON.parse(key) as Array<{
          environmentId: EnvironmentId;
          sagaRoot: string;
        }>;
        const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
        if (!environmentSupportsStave(config) || !config?.settings.stave.enabled) return;
        for (const target of targets) {
          if (target.environmentId === environmentId)
            appAtomRegistry.refresh(
              staveSagaStatus({ environmentId, input: { sagaRoot: target.sagaRoot } }),
            );
        }
      }),
    [key],
  );
  return entries;
}

export function useStaveSagaStatus(
  environmentId: EnvironmentId,
  sagaRoot: string,
  enabled: boolean,
) {
  const query = useEnvironmentQuery(
    enabled ? staveSagaStatus({ environmentId, input: { sagaRoot } }) : null,
  );
  const refresh = query.refresh;
  useEffect(
    () =>
      subscribeStaveMutation((changed) => {
        if (enabled && changed === environmentId) refresh();
      }),
    [enabled, environmentId, refresh],
  );
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [enabled, refresh]);
  return query;
}

// ── Wizard reads ──────────────────────────────────────────────
// Registry, spaces (live + archived), sagas and memory providers for the
// "New Stave space" wizard. Short stale windows: the wizard mutates the
// registry (inline `registerRepo`) and refreshes explicitly afterwards.

export const staveRepos = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:stave:repos",
  tag: WS_METHODS.staveListRepos,
  staleTimeMs: 15_000,
});

export const staveSpaces = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:stave:spaces",
  tag: WS_METHODS.staveListSpaces,
  staleTimeMs: 15_000,
});

// A picker can open after a mutation that ran while nothing listed spaces
// (an archive from the sidebar): drop the cached list so it opens current.
subscribeStaveMutation((environmentId) => {
  for (const includeArchived of [true, false])
    appAtomRegistry.refresh(staveSpaces({ environmentId, input: { includeArchived } }));
});

export const staveSagas = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:stave:sagas",
  tag: WS_METHODS.staveListSagas,
  staleTimeMs: 15_000,
});

export const staveMemoryProviders = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:stave:memory-providers",
  tag: WS_METHODS.staveMemoryProviders,
  staleTimeMs: 60_000,
});

/** `stave <verb> --dry-run --json` for the review step; a read, but run on demand rather than cached. */
export const staveDryRun = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:stave:dry-run",
  tag: WS_METHODS.staveDryRun,
});

/** A fresh `space list` (live + archived) for restore, undo and delete; bypasses the query cache. */
export const staveSpacesRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:stave:spaces-fresh",
  tag: WS_METHODS.staveListSpaces,
});

/** Bypasses client query caching when a confirmation needs the current saga roster. */
export const staveSpaceStatusRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:stave:space-status-fresh",
  tag: WS_METHODS.staveSpaceStatus,
});

const EMPTY_SPACE_STATUS_ATOM = Atom.make(AsyncResult.initial<StaveSpaceStatus, never>(false)).pipe(
  Atom.withLabel("web-stave-space-status:empty"),
);

export interface StaveStatusView extends EnvironmentQueryView<
  NonNullable<ReturnType<typeof useStaveStatusQuery>["data"]>
> {
  /** `capabilities.stave` is present: configuration rows may render. */
  readonly supported: boolean;
}

function useStaveStatusQuery(environmentId: EnvironmentId | null, supported: boolean) {
  return useEnvironmentQuery(
    environmentId !== null && supported ? staveStatus({ environmentId, input: {} }) : null,
  );
}

/**
 * `stave.getStatus` for an environment, fetched only when the server build
 * supports Stave. Re-probes when the user changes any `stave.*` setting
 * (binary path, config path, enabled), since the server memo is invalidated
 * on the same edit.
 */
export function useStaveStatus(environmentId: EnvironmentId | null): StaveStatusView {
  const config = useAtomValue(
    environmentId === null ? NULL_CONFIG_ATOM : serverEnvironment.configValueAtom(environmentId),
  );
  const supported = environmentSupportsStave(config);
  const query = useStaveStatusQuery(environmentId, supported);
  const stave = config?.settings.stave;
  const settingsKey =
    stave === undefined ? null : `${stave.enabled}\0${stave.binaryPath}\0${stave.configPath}`;
  const lastSettingsKey = useRef(settingsKey);
  const refresh = query.refresh;
  useEffect(() => {
    if (lastSettingsKey.current === settingsKey) return;
    lastSettingsKey.current = settingsKey;
    if (settingsKey !== null && supported) refresh();
  }, [refresh, settingsKey, supported]);
  return { ...query, supported };
}

const NULL_CONFIG_ATOM = Atom.make(null).pipe(Atom.withLabel("web-stave-config:null"));

export interface StaveFeatureView {
  readonly supported: boolean;
  /** Supported, enabled in settings, and a binary is runnable. */
  readonly available: boolean;
  readonly status: StaveStatusView;
}

export function useStaveFeatureAvailable(environmentId: EnvironmentId | null): StaveFeatureView {
  const config = useAtomValue(
    environmentId === null ? NULL_CONFIG_ATOM : serverEnvironment.configValueAtom(environmentId),
  );
  const status = useStaveStatus(environmentId);
  return {
    supported: status.supported,
    available: staveFeatureAvailable({ config, settings: config?.settings, status: status.data }),
    status,
  };
}

export interface StaveSpaceStatusView {
  readonly data: StaveSpaceStatus | null;
  /** The squashed failure, kept typed so callers can match `_tag`. */
  readonly error: unknown;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

/**
 * `stave.spaceStatus` for a project's workspace root. Only fetched when the
 * feature gate passes, so a disabled or binary-less server never sees the
 * call; callers render the typed error inline instead of throwing.
 */
export function useStaveSpaceStatus(target: {
  readonly environmentId: EnvironmentId | null;
  readonly workspaceRoot: string | null;
  readonly enabled: boolean;
}): StaveSpaceStatusView {
  const atom =
    target.enabled && target.environmentId !== null && target.workspaceRoot !== null
      ? staveSpaceStatus({
          environmentId: target.environmentId,
          input: { workspaceRoot: target.workspaceRoot },
        })
      : EMPTY_SPACE_STATUS_ATOM;
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  useEffect(
    () =>
      subscribeStaveMutation((changed) => {
        if (target.enabled && changed === target.environmentId) refresh();
      }),
    [target.enabled, target.environmentId, refresh],
  );
  useEffect(() => {
    if (atom === EMPTY_SPACE_STATUS_ATOM) return;
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [atom, refresh]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? Cause.squash(result.cause) : null,
    isPending: atom !== EMPTY_SPACE_STATUS_ATOM && result.waiting,
    refresh,
  };
}

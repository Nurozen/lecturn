import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type EnvironmentCloudLinkStateResult } from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { HttpClient } from "effect/unstable/http";
import { useCallback, useMemo } from "react";

import { connectedGenerationSignal } from "./primaryCloudLinkRefresh";

import { environmentCatalog } from "../connection/catalog";
import { usePrimaryEnvironment } from "../state/environments";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPrimaryCloudLinkState, type CloudLinkTarget } from "./linkEnvironment";

const primaryCloudLinkAtomRuntime = Atom.runtime(
  Layer.effect(
    HttpClient.HttpClient,
    runtime.contextEffect.pipe(
      Effect.map((context) => Context.get(context, HttpClient.HttpClient)),
    ),
  ),
);

const primaryCloudLinkStateAtom = Atom.family((key: string) => {
  const target = JSON.parse(key) as CloudLinkTarget;
  const connectedGeneration = connectedGenerationSignal(
    Atom.make((get) =>
      Option.getOrUndefined(
        AsyncResult.value(
          get(environmentCatalog.stateAtom(EnvironmentId.make(target.environmentId))),
        ),
      ),
    ),
  );
  return primaryCloudLinkAtomRuntime.atom(readPrimaryCloudLinkState({ target })).pipe(
    Atom.swr({
      staleTime: 5_000,
      revalidateOnMount: true,
      revalidateOnFocus: true,
      focusSignal: typeof window === "undefined" ? undefined : Atom.windowFocusSignal,
    }),
    Atom.makeRefreshOnSignal(connectedGeneration),
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`primary-cloud-link:${target.environmentId}`),
  );
});

const EMPTY_PRIMARY_CLOUD_LINK_STATE_ATOM = Atom.make(
  AsyncResult.success<EnvironmentCloudLinkStateResult | null>(null),
).pipe(Atom.keepAlive, Atom.withLabel("primary-cloud-link:null"));

function targetKey(target: CloudLinkTarget): string {
  return JSON.stringify(target);
}

/** The local host's publisher is authoritative even when another account is active. */
export const primaryCloudPublisherAtom = Atom.make((get) => {
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (entry.target._tag !== "PrimaryConnectionTarget") continue;
    const target: CloudLinkTarget = {
      environmentId,
      label: entry.target.label,
      httpBaseUrl: entry.target.httpBaseUrl,
      wsBaseUrl: entry.target.wsBaseUrl,
    };
    const state = Option.getOrNull(
      AsyncResult.value(get(primaryCloudLinkStateAtom(targetKey(target)))),
    );
    return state?.linked && state.cloudUserId && !state.deviceRelayConflict
      ? { environmentId, accountId: state.cloudUserId }
      : null;
  }
  return null;
}).pipe(Atom.withLabel("primary-cloud-publisher"));

export function refreshPrimaryCloudLinkState(target: CloudLinkTarget | null): void {
  if (target) {
    appAtomRegistry.refresh(primaryCloudLinkStateAtom(targetKey(target)));
  }
}

export function usePrimaryCloudLinkState() {
  const primary = usePrimaryEnvironment();
  const target = useMemo(
    () =>
      primary?.entry.target._tag === "PrimaryConnectionTarget"
        ? {
            environmentId: primary.environmentId,
            label: primary.label,
            httpBaseUrl: primary.entry.target.httpBaseUrl,
            wsBaseUrl: primary.entry.target.wsBaseUrl,
          }
        : null,
    [primary],
  );
  const atom = target
    ? primaryCloudLinkStateAtom(targetKey(target))
    : EMPTY_PRIMARY_CLOUD_LINK_STATE_ATOM;
  const result = useAtomValue(atom);
  const refresh = useCallback(() => {
    refreshPrimaryCloudLinkState(target);
  }, [target]);
  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Could not read Lecturn Connect link state.";
  }

  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error,
    isPending: result.waiting,
    refresh,
    target,
  };
}

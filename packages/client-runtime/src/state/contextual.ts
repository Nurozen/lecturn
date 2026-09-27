import { HttpClient, FetchHttpClient } from "effect/unstable/http";
import {
  ContextualError,
  type ContextualCaptureStatusResult,
  type ContextualDisclosure,
  type ContextualPreparation,
  type ExtensionFundingStatusResult,
  type ExtensionFundingChallengeResult,
} from "@lecturn/contracts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { buildEnvironmentAuthHeaders } from "./environmentHttpAuth.ts";
import { WS_METHODS, type EnvironmentId, type ContextualEffectiveState } from "@lecturn/contracts";
import { Effect, Option, Stream, SubscriptionRef } from "effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** A newer confirmed funding revision makes a local challenge obsolete, without proving who approved it. */
export function fundingSupersedesChallenge(
  challenge: ExtensionFundingChallengeResult,
  status: ExtensionFundingStatusResult | null | undefined,
): boolean {
  return (
    !!status &&
    status.state !== "unavailable" &&
    status.environmentId === challenge.environmentId &&
    status.featureId === challenge.featureId &&
    status.generation > challenge.generation
  );
}

export function contextualStateLabel(state: ContextualEffectiveState): string {
  return {
    ready: "Ready for your next message",
    off: "Off for this thread",
    "funding-required": "Membership funding required",
    "allowance-exhausted": "Shared allowance exhausted",
    "helper-unavailable": "Local collection unavailable on this host",
    "source-unavailable": "No permitted sources available",
    "unsupported-provider": "This provider does not support Contextual",
    unavailable: "Contextual is temporarily unavailable",
  }[state.reason];
}

/** Explains the same prerequisites that disable starting collection on every client. */
export function contextualCollectionPresentation(input: {
  capture: Pick<ContextualCaptureStatusResult, "state" | "reason"> | null | undefined;
  funding: Pick<ExtensionFundingStatusResult, "state" | "eligible" | "reason"> | null | undefined;
  captureFailed?: boolean;
  fundingFailed?: boolean;
}): { canStart: boolean; message: string } {
  const { capture, funding } = input;
  if (!capture)
    return {
      canStart: false,
      message: input.captureFailed
        ? "Collection status could not be checked. Reconnect this host and refresh status."
        : "Checking this host’s collection status…",
    };
  if (capture.state === "running")
    return {
      canStart: true,
      message: "Collecting from selected Slack desktop caches on this host.",
    };
  if (
    input.fundingFailed ||
    funding?.state === "unavailable" ||
    funding?.reason === "unavailable" ||
    funding?.reason === "stale-billing"
  )
    return {
      canStart: false,
      message:
        "Collection cannot start because membership access could not be verified. Check this host’s connection and refresh status.",
    };
  if (!funding)
    return { canStart: false, message: "Checking membership access before collection can start…" };
  if (funding.state === "pending")
    return {
      canStart: false,
      message: "Complete membership approval below, then refresh status to start collection.",
    };
  if (funding.reason === "disabled" || funding.reason === "cohort")
    return {
      canStart: false,
      message:
        "Contextual is not currently available for this membership. Review membership access below.",
    };
  if (funding.state !== "active" || !funding.eligible)
    return {
      canStart: false,
      message: "Link an eligible membership for Contextual below before starting collection.",
    };
  return { canStart: capture.state !== "unavailable", message: captureReason(capture.reason) };
}

export function captureReason(reason: ContextualCaptureStatusResult["reason"]): string {
  return {
    requested: "Collection is paused. Start collection when you’re ready.",
    ready: "Collecting from selected Slack desktop caches on this host.",
    "funding-required": "Approve Contextual membership access before starting collection.",
    "eligibility-expired": "Refresh membership status before resuming collection.",
    revoked: "Contextual membership access was revoked. New collection is paused.",
    "unsupported-format":
      "This Slack cache format is not supported. Saved Decisions remain available independently.",
    "storage-limit":
      "Collection reached a local storage limit. Export or forget unused archive data before resuming.",
    "source-unavailable":
      "No selected Slack desktop cache is available on this host. Review the selected sources below.",
    "helper-unavailable":
      "Local collection is unavailable on this host. Reconnect the host and refresh status. Saved Decisions remain available independently.",
  }[reason];
}

/** Historical preparations only explain causes recorded when that turn ran. */
export function contextualPreparationOutcome(
  preparation: Pick<ContextualPreparation, "state" | "skipReason"> | null | undefined,
): string | null {
  if (!preparation) return null;
  if (preparation.state === "skipped") {
    switch (preparation.skipReason) {
      case "evaluation-incomplete":
        return "Contextual could not finish checking this context within the message’s limit. Your message was sent without it.";
      case "user-requested":
        return "Sent without context at your request.";
      case "funding-required":
        return "No context added: membership access is required. Review Contextual settings before your next message.";
      case "allowance-exhausted":
        return "No context added: the shared allowance is exhausted. Check membership usage in Contextual settings.";
      case "source-unavailable":
        return "No context added: selected sources were unavailable. Check Contextual sources before your next message.";
      case "unavailable":
        return "Context was unavailable for this message. Check this host’s connection and Contextual settings before trying again.";
      default:
        return "No context was added to this message. The reason was not recorded. Check Contextual settings before your next message.";
    }
  }
  switch (preparation.state) {
    case "no-useful-context":
      return "No useful context found for this message.";
    case "already-supplied":
      return "Useful context was already supplied.";
    case "failed":
      return "Context preparation failed. Check Contextual settings before your next message.";
    case "canceled":
      return "Context preparation canceled.";
    case "delivery-unknown":
      return "Context delivery could not be confirmed.";
    default:
      return null;
  }
}

/** Routine empty or previously supplied results belong in settings, not repeated transcript cards. */
export function contextualTranscriptOutcome(
  preparation: Pick<ContextualPreparation, "state" | "skipReason"> | null | undefined,
): string | null {
  return preparation?.state === "no-useful-context" || preparation?.state === "already-supplied"
    ? null
    : contextualPreparationOutcome(preparation);
}

/** Display copy never substitutes for the exact packet delivered to the agent. */
export function contextualDisclosurePreview(disclosure: ContextualDisclosure): string | null {
  if (
    disclosure.retention !== "available" ||
    disclosure.receipt.acceptance !== "accepted" ||
    !disclosure.receipt.evidenceIncluded ||
    !disclosure.packet
  )
    return null;
  const supplied = new Set(disclosure.receipt.suppliedEvidenceIds);
  const evidence = disclosure.packet.groups.flatMap((group) =>
    group.evidence.filter((item) => supplied.has(item.id)),
  );
  if (!evidence.length) return null;
  if (disclosure.displaySummary?.state === "ready") return disclosure.displaySummary.text;
  const quotes = [...new Set(evidence.map((item) => item.quote))].join("\n\n");
  const sourceCount = new Set(evidence.map((item) => item.sourceId)).size;
  return quotes.length <= 700
    ? quotes
    : `Relevant context from ${sourceCount} ${sourceCount === 1 ? "source" : "sources"} was added. Expand the original sources to read the full context.`;
}

/** Query identities include the environment and full RPC payload. Mutations are serialized per host. */
export function createContextualEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const changes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "contextual:changes",
    tag: WS_METHODS.contextualSubscribe,
    transform: (stream) => stream.pipe(Stream.map((event) => event.sequence)),
  });
  const manual = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`contextual:refresh:${environmentId}`)),
  );
  const refresh = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const sequence = Option.getOrNull(
        AsyncResult.value(get(changes({ environmentId, input: { afterSequence: 0 } }))),
      );
      return `${get(manual(environmentId))}:${sequence ?? 0}`;
    }),
  );
  const refreshTrigger = ({ environmentId }: { environmentId: EnvironmentId }) =>
    refresh(environmentId);
  const options = {
    scheduler: createAtomCommandScheduler(),
    concurrency: {
      mode: "serial",
      key: ({ environmentId }: { environmentId: EnvironmentId }) => environmentId,
    },
    onSuccess: (
      { environmentId }: { environmentId: EnvironmentId },
      registry: AtomRegistry.AtomRegistry,
    ) => Effect.sync(() => registry.update(manual(environmentId), (value) => value + 1)),
  } as const;
  return {
    changes,
    downloadExport: createEnvironmentCommand(runtime, {
      label: "contextual:download-export",
      execute: ({ artifactId }: { artifactId: string }) =>
        Effect.gen(function* () {
          if (!/^[a-zA-Z0-9_-]{1,240}(?:\.jsonl)?$/.test(artifactId))
            return yield* new ContextualError({
              code: "invalid",
              message: "Invalid export artifact",
            });
          const supervisor = yield* EnvironmentSupervisor;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared))
            return yield* new ContextualError({
              code: "unavailable",
              message: "Reconnect this environment to download the export.",
            });
          const connection = prepared.value;
          const url = environmentEndpointUrl(
            connection.httpBaseUrl,
            `/api/contextual/exports/${encodeURIComponent(artifactId)}`,
          );
          const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
          const headers = yield* buildEnvironmentAuthHeaders(
            connection.httpAuthorization,
            "GET",
            url,
            signer,
          );
          const request = Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;
            const response = yield* client.get(url, { headers: { ...headers } });
            if (response.status !== 200)
              return yield* new ContextualError({
                code: response.status === 404 ? "not-found" : "unavailable",
                message:
                  response.status === 404
                    ? "This export expired or was forgotten. Create a new export."
                    : "The export could not be downloaded with this connection.",
              });
            const content = yield* response.stream.pipe(
              Stream.runFoldEffect(
                () => ({ chunks: [] as Uint8Array[], length: 0 }),
                (state, chunk) => {
                  if (state.length + chunk.length > 64 * 1024 * 1024)
                    return Effect.fail(
                      new ContextualError({
                        code: "unavailable",
                        message: "This export exceeds the download limit. Export fewer sources.",
                      }),
                    );
                  state.chunks.push(chunk);
                  state.length += chunk.length;
                  return Effect.succeed(state);
                },
              ),
            );
            const result = new Uint8Array(content.length);
            let offset = 0;
            for (const chunk of content.chunks) {
              result.set(chunk, offset);
              offset += chunk.length;
            }
            return result.buffer;
          }).pipe(
            Effect.provideService(FetchHttpClient.RequestInit, {
              credentials: connection.httpAuthorization === null ? "include" : "omit",
              cache: "no-store",
              redirect: "error",
            }),
            Effect.provide(FetchHttpClient.layer),
          );
          return yield* request.pipe(
            Effect.mapError((error) =>
              error._tag === "ContextualError"
                ? error
                : new ContextualError({
                    code: "unavailable",
                    message: "Could not download the export.",
                  }),
            ),
          );
        }).pipe(Effect.timeout("60 seconds")),
    }),
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "contextual:status",
      tag: WS_METHODS.contextualStatus,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    projectSettings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "contextual:projectSettings",
      tag: WS_METHODS.contextualProjectSettings,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    disclosures: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "contextual:disclosures",
      tag: WS_METHODS.contextualDisclosures,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    conflicts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "contextual:conflicts",
      tag: WS_METHODS.contextualConflicts,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    group: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "contextual:group",
      tag: WS_METHODS.contextualGroup,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    sources: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "contextual:sources",
      tag: WS_METHODS.contextualSources,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    captureStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "contextual:captureStatus",
      tag: WS_METHODS.contextualCaptureStatus,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    inspect: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "contextual:inspect",
      tag: WS_METHODS.contextualInspect,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    evidence: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "contextual:evidence",
      tag: WS_METHODS.contextualEvidence,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    fundingStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "contextual:fundingStatus",
      tag: WS_METHODS.extensionsFundingStatus,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    updateProjectSettings: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:updateProjectSettings",
      tag: WS_METHODS.contextualUpdateProjectSettings,
    }),
    updateThreadSettings: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:updateThreadSettings",
      tag: WS_METHODS.contextualUpdateThreadSettings,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:refresh",
      tag: WS_METHODS.contextualRefresh,
    }),
    exclude: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:exclude",
      tag: WS_METHODS.contextualExclude,
    }),
    preparationAction: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:preparationAction",
      tag: WS_METHODS.contextualPreparationAction,
    }),
    resolveConflict: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:resolveConflict",
      tag: WS_METHODS.contextualResolveConflict,
    }),
    mutateGroup: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:mutateGroup",
      tag: WS_METHODS.contextualMutateGroup,
    }),
    undoGroup: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:undoGroup",
      tag: WS_METHODS.contextualUndoGroup,
    }),
    configureSources: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:configureSources",
      tag: WS_METHODS.contextualConfigureSources,
    }),
    setCapture: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:setCapture",
      tag: WS_METHODS.contextualSetCapture,
    }),
    export: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:export",
      tag: WS_METHODS.contextualExport,
    }),
    forget: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:forget",
      tag: WS_METHODS.contextualForget,
    }),
    funding: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "contextual:funding",
      tag: WS_METHODS.extensionsFunding,
    }),
  };
}

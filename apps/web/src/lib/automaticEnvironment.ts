import type { EnvironmentId, ProjectId, ServerProvider } from "@lecturn/contracts";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import { contextualDraftKey, useContextualDrafts } from "../state/contextualDrafts";

/** Read the current stores again when telemetry completes or routing is retried. */
export function canAutomaticallyRetargetDraft(input: {
  draftId: DraftId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const draft = useComposerDraftStore.getState().getComposerDraft(input.draftId);
  return (
    !(draft && composerDraftHasUserContent({ ...draft, prompt: "" })) &&
    !useContextualDrafts.getState().choices[
      contextualDraftKey(input.environmentId, input.projectId, input.draftId)
    ]
  );
}

/** Automatic moves keep both the Connect owner and the selected provider account. */
export function canAutomaticallyRouteToEnvironment(input: {
  sourceEnvironmentId: string;
  targetEnvironmentId: string;
  accountByEnvironmentId: ReadonlyMap<string, string>;
  selectedProvider: ServerProvider | null;
  providers: readonly ServerProvider[];
}) {
  if (
    input.accountByEnvironmentId.get(input.sourceEnvironmentId) !==
    input.accountByEnvironmentId.get(input.targetEnvironmentId)
  ) {
    return false;
  }
  const selected = input.selectedProvider;
  if (!selected) return false;
  const email = selected.auth.email?.trim().toLowerCase();
  const moving = input.sourceEnvironmentId !== input.targetEnvironmentId;
  // Instance names are environment-local; without an email they cannot prove
  // that another machine will run under the same provider account.
  if (moving && (!email || selected.auth.status !== "authenticated")) return false;
  return input.providers.some(
    (provider) =>
      provider.instanceId === selected.instanceId &&
      provider.driver === selected.driver &&
      (!email || provider.auth.email?.trim().toLowerCase() === email) &&
      (!moving || provider.auth.status === "authenticated") &&
      provider.enabled &&
      provider.installed &&
      provider.status !== "error" &&
      provider.auth.status !== "unauthenticated" &&
      provider.availability !== "unavailable",
  );
}

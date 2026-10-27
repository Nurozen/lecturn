import { resolveProviderInstanceDisplayName } from "@lecturn/client-runtime/state/provider-instance-display";
import type {
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerSettings,
} from "@lecturn/contracts";
import {
  type LegacyProjectSettingsFields,
  resolveProjectSettings,
} from "@lecturn/shared/projectSettings";

import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import {
  getProviderStatusBannerKey,
  getProviderStatusMessage,
  hasProviderSetup,
} from "../chat/ProviderStatusBanner";

export type EmbedProviderState =
  | "checking"
  | "ready"
  | "not-installed"
  | "signed-out"
  | "attention";

export interface EmbedProviderRow {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly name: string;
  readonly version: string | null;
  readonly state: EmbedProviderState;
  /** What to do about a provider that is not ready; null when there is nothing to do. */
  readonly detail: string | null;
  readonly account: string | null;
}

/**
 * The status helpers point at Lecturn's provider setup when the server gave no
 * message of its own. The embed has no setup screen and its user may not have
 * Lecturn installed, so those cases say what to do on the machine instead.
 */
function pointsAtProviderSetup(status: ServerProvider): boolean {
  const brokenMessage =
    status.auth.status !== "unauthenticated" &&
    status.compatibilityAdvisory?.status === "broken" &&
    status.compatibilityAdvisory.message;
  return (
    !brokenMessage &&
    !status.message &&
    hasProviderSetup(status) &&
    (!status.installed || status.auth.status === "unauthenticated")
  );
}

function embedProviderStatusMessage(status: ServerProvider): string {
  if (!pointsAtProviderSetup(status)) return getProviderStatusMessage(status);
  const name = resolveProviderInstanceDisplayName(status);
  return status.installed
    ? "Sign in via the CLI to authenticate again."
    : `Install ${name} on this computer, then check again.`;
}

function rowState(status: ServerProvider): EmbedProviderState {
  if (status.discovery?.status === "detecting") return "checking";
  if (!status.installed) return "not-installed";
  if (status.auth.status === "unauthenticated") return "signed-out";
  return getProviderStatusBannerKey(status) === null ? "ready" : "attention";
}

/** Status only: install and sign-in stay with the provider's own CLI. */
export function deriveEmbedProviderRows(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<EmbedProviderRow> {
  return providers
    .filter((status) => status.enabled && status.status !== "disabled")
    .map((status) => {
      const state = rowState(status);
      const settled = state === "ready" || state === "checking";
      return {
        instanceId: status.instanceId,
        driverKind: status.driver,
        name: resolveProviderInstanceDisplayName(status),
        version: status.version,
        state,
        detail: settled ? null : embedProviderStatusMessage(status),
        account: state === "ready" ? (status.auth.email ?? status.auth.label ?? null) : null,
      };
    });
}

export interface EmbedDefaultModel {
  /** What a new thread in this project starts with; null when no provider can run one. */
  readonly selection: ModelSelection | null;
  /** The project names its own default, so resetting it returns to the environment's. */
  readonly projectOverride: boolean;
}

export function resolveEmbedDefaultModel(input: {
  readonly settings: ServerSettings;
  readonly projectId: ProjectId;
  readonly project: LegacyProjectSettingsFields | null;
  readonly providers: ReadonlyArray<ServerProvider>;
}): EmbedDefaultModel {
  const resolved = resolveProjectSettings(input.settings, input.projectId, input.project);
  return {
    selection: resolveDefaultProviderModelSelection(
      input.providers,
      resolved.settings.defaultModelSelection,
    ),
    projectOverride: resolved.sources.defaultModelSelection === "project",
  };
}

import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentId, ModelSelection, ProjectId } from "@lecturn/contracts";
import { createModelSelection } from "@lecturn/shared/model";
import { ArrowLeftIcon, RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { appsEnvironment, useAppEmbedContext } from "../../state/apps";
import { useProject } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  deriveEmbedProviderRows,
  type EmbedProviderState,
  resolveEmbedDefaultModel,
} from "./EmbedProvidersPanel.logic";

const STATE_BADGES: Record<
  EmbedProviderState,
  { readonly label: string; readonly variant: "success" | "secondary" | "warning" }
> = {
  ready: { label: "Ready", variant: "success" },
  checking: { label: "Checking", variant: "secondary" },
  "not-installed": { label: "Not installed", variant: "warning" },
  "signed-out": { label: "Signed out", variant: "warning" },
  attention: { label: "Needs attention", variant: "warning" },
};

/**
 * Provider status for an embedded app's users, who may not have Lecturn
 * installed: status only, since installing and signing in happen in each
 * provider's own CLI. Its one setting is the model this app's new threads use.
 */
export function EmbedProvidersPanel({
  environmentId,
  projectId,
  onBack,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onBack: () => void;
}) {
  const projectRef = scopeProjectRef(environmentId, projectId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const settings = useEnvironmentSettings(environmentId);
  const project = useProject(projectRef);
  const appName = useAppEmbedContext(projectRef)?.name ?? "this app";
  const rows = deriveEmbedProviderRows(providers);
  const defaults = resolveEmbedDefaultModel({ settings, projectId, project, providers });
  const selection = defaults.selection;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, projectId),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );

  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const setDefaultModel = useAtomCommand(appsEnvironment.setEmbedDefaultModel, {
    reportFailure: false,
  });
  const [checking, setChecking] = useState(false);
  const checkAgain = async () => {
    setChecking(true);
    const result = await refresh({ environmentId, input: {} });
    setChecking(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Couldn't check providers" });
    }
  };
  const saveDefault = async (modelSelection: ModelSelection | null) => {
    const result = await setDefaultModel({ environmentId, input: { projectId, modelSelection } });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Default model not saved" });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 shrink-0 items-center gap-1 border-b px-2 py-1">
        <Button variant="ghost" size="xs" onClick={onBack}>
          <ArrowLeftIcon aria-hidden="true" />
          Back to chat
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Providers</h1>
        <Button variant="ghost" size="xs" disabled={checking} onClick={() => void checkAgain()}>
          <RotateCwIcon aria-hidden="true" />
          {checking ? "Checking…" : "Check again"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        <section className="space-y-2" aria-labelledby="embed-default-model">
          <h2 id="embed-default-model" className="text-sm font-medium">
            Default model
          </h2>
          <p className="text-sm text-muted-foreground">
            New threads in {appName} start with this model.
          </p>
          {selection ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={modelOptions}
                onInstanceModelChange={(instanceId, model) =>
                  void saveDefault(createModelSelection(instanceId, model))
                }
              />
              {defaults.projectOverride ? (
                <Button variant="link" size="xs-flush" onClick={() => void saveDefault(null)}>
                  Use Lecturn's default
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No provider is ready. Install or sign in to one below.
            </p>
          )}
        </section>
        <section className="space-y-2" aria-labelledby="embed-provider-status">
          <h2 id="embed-provider-status" className="text-sm font-medium">
            Status on this computer
          </h2>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No providers are turned on.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {rows.map((row) => {
                const badge = STATE_BADGES[row.state];
                return (
                  <li key={row.instanceId} className="flex items-start gap-3 px-3 py-2.5">
                    <ProviderInstanceIcon
                      driverKind={row.driverKind}
                      displayName={row.name}
                      className="mt-0.5 size-4 shrink-0"
                    />
                    <div className="min-w-0 flex-1 space-y-0.5 text-sm">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{row.name}</span>
                        {row.version ? (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {row.version}
                          </span>
                        ) : null}
                        <Badge variant={badge.variant} className="ml-auto shrink-0">
                          {badge.label}
                        </Badge>
                      </div>
                      {row.account ? (
                        <p className="truncate text-muted-foreground">{row.account}</p>
                      ) : null}
                      {row.detail ? (
                        <p className="break-words text-muted-foreground">{row.detail}</p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

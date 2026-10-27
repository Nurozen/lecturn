import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProviderInstanceId,
  type RunId,
  type ScopedThreadRef,
  type ServerProvider,
} from "@lecturn/contracts";

import { type EmbedPresentation, useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import { getProviderInstanceEntry } from "../../providerInstances";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import type { HandoffTimelineRun } from "../chat/V2LifecycleRow";
import { resolveEmbedDefaultModel } from "./EmbedProvidersPanel.logic";

interface EmbedAgentNameProps {
  readonly runId: RunId | null | undefined;
  readonly timeline: {
    readonly runs: ReadonlyArray<HandoffTimelineRun>;
    readonly activeThreadEnvironmentId: EnvironmentId;
    readonly threadRef: ScopedThreadRef | null;
  };
}

/**
 * The host app's agent pane writes a reply as plain prose under the agent's name, with no avatar.
 * Full Lecturn leaves replies unnamed, so this renders only inside the embed.
 */
export function EmbedAgentName(props: EmbedAgentNameProps) {
  const presentation = useEmbedPresentation();
  if (presentation === null) return null;
  return <AgentName {...props} presentation={presentation} />;
}

/** The first candidate this environment can name; null rather than an empty line. */
function embedAgentDisplayName(
  providers: ReadonlyArray<ServerProvider>,
  candidates: ReadonlyArray<ProviderInstanceId | null | undefined>,
): string | null {
  for (const instanceId of candidates) {
    if (instanceId == null) continue;
    const name = getProviderInstanceEntry(providers, instanceId)?.displayName.trim();
    if (name) return name;
  }
  return null;
}

function AgentName({
  runId,
  timeline,
  presentation,
}: EmbedAgentNameProps & { readonly presentation: EmbedPresentation }) {
  const environmentId = timeline.activeThreadEnvironmentId;
  const { projectRef } = presentation;
  // An imported or copied thread has no runs here, so its reply takes the agent that answers in
  // this thread now: the latest run's, else the thread's model, else this app's default model.
  const run =
    (runId == null ? undefined : timeline.runs.find((candidate) => candidate.id === runId)) ??
    timeline.runs.at(-1);
  const shell = useQuietThreadShell(timeline.threadRef);
  const project = useProject(projectRef);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const name = useAtomValue(serverEnvironment.providersValueAtom(environmentId), (value) => {
    const providers = value ?? EMPTY_SERVER_PROVIDERS;
    const appDefault = resolveEmbedDefaultModel({
      settings: settings ?? DEFAULT_SERVER_SETTINGS,
      projectId: projectRef.projectId,
      project,
      providers,
    }).selection;
    return embedAgentDisplayName(providers, [
      run?.providerInstanceId,
      shell?.modelSelection?.instanceId,
      shell?.providerInstanceId,
      appDefault?.instanceId,
    ]);
  });
  if (name === null) return null;
  return (
    <p
      aria-hidden
      data-thread-find-ignore
      data-testid="embed-agent-name"
      className="mb-1 truncate font-medium text-muted-foreground text-xs"
    >
      {name}
    </p>
  );
}

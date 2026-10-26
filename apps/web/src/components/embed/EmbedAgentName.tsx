import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, RunId } from "@lecturn/contracts";

import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import { getProviderInstanceEntry } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import type { HandoffTimelineRun } from "../chat/V2LifecycleRow";

interface EmbedAgentNameProps {
  readonly runId: RunId | null | undefined;
  readonly timeline: {
    readonly runs: ReadonlyArray<HandoffTimelineRun>;
    readonly activeThreadEnvironmentId: EnvironmentId;
  };
}

/**
 * The host app's agent pane writes a reply as plain prose under the agent's name, with no avatar.
 * Full Lecturn leaves replies unnamed, so this renders only inside the embed.
 */
export function EmbedAgentName(props: EmbedAgentNameProps) {
  if (useEmbedPresentation() === null) return null;
  return <AgentName {...props} />;
}

function AgentName({ runId, timeline }: EmbedAgentNameProps) {
  // An imported reply has no run, so it takes the agent that answers in this thread now.
  const run =
    (runId == null ? undefined : timeline.runs.find((candidate) => candidate.id === runId)) ??
    timeline.runs.at(-1);
  const instanceId = run?.providerInstanceId;
  const name = useAtomValue(
    serverEnvironment.providersValueAtom(timeline.activeThreadEnvironmentId),
    (providers) =>
      instanceId === undefined
        ? undefined
        : getProviderInstanceEntry(providers ?? EMPTY_SERVER_PROVIDERS, instanceId)?.displayName,
  );
  if (name === undefined) return null;
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

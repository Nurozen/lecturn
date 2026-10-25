import { deriveEmbedTurnState } from "@lecturn/client-runtime/embed/guest";
import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import { readEmbedBridge, startEmbedBridge } from "../../embed/bridge";
import { runEmbedHostCommand, type EmbedNewThread } from "../../embed/hostCommands";
import { appsEnvironment, useAppEmbedContext } from "../../state/apps";
import {
  useQuietThreadShell,
  useThreadProjection,
  useThreadShellsForProjectRefs,
} from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { toastManager } from "../ui/toast";
import { AppReferencesContext } from "./AppReferencesContext";
import { EmbedProvidersPanel } from "./EmbedProvidersPanel";
import { EmbedThreadSwitcher } from "./EmbedThreadSwitcher";

/**
 * Tells the host what the pane shows. A leaf of its own, because the thread detail it reads
 * changes on every streamed event and must not re-render the ChatView beside it.
 */
function EmbedThreadReporter({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
}) {
  const threadRef = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const shell = useQuietThreadShell(threadRef);
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const state = threadId === null ? null : deriveEmbedTurnState({ projection, shell });
  const loaded = threadId === null || projection !== null;
  useEffect(() => {
    const bridge = startEmbedBridge();
    bridge?.reportThread(threadId);
    if (threadId !== null && state !== null) bridge?.reportTurnState(threadId, state);
  }, [threadId, state]);
  useEffect(() => {
    if (loaded) startEmbedBridge()?.reportReady(threadId);
  }, [threadId, loaded]);
  return null;
}

/** A full-pane view that replaces the chat until the user goes back to it. */
export type EmbedPanel = "providers";

/** The embedded project: its thread (or switcher), driven by the host over the bridge. */
export function EmbedView({
  environmentId,
  projectId,
  threadId,
  panel,
  switcher,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly panel: EmbedPanel | null;
  readonly switcher: boolean;
}) {
  const projectRef = scopeProjectRef(environmentId, projectId);
  const projectRefs = [projectRef];
  const liveThreads = useThreadShellsForProjectRefs(projectRefs)
    .filter((thread) => thread.archivedAt === null && thread.deletedAt === null)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  // A host may open the project without naming a thread, and the embed has no draft composer to
  // fall back to, so it shows the project's most recent live thread.
  // A panel's route names no thread; the host keeps hearing about the one the user left.
  const [lastThreadId, setLastThreadId] = useState(threadId);
  if (threadId !== null && threadId !== lastThreadId) setLastThreadId(threadId);
  const shownThreadId =
    threadId ?? (panel === null ? null : lastThreadId) ?? liveThreads[0]?.id ?? null;

  const appContext = useAppEmbedContext(projectRef);
  // Only the first known origins count: the bridge decides once whether its parent may listen.
  useEffect(() => {
    if (appContext !== null) startEmbedBridge()?.authorizeHost(appContext.embedOrigins);
  }, [appContext]);
  const appReferences =
    appContext === null
      ? null
      : {
          refPrefixes: appContext.refPrefixes,
          iconUrl: appContext.iconDataUrl,
          activate: (ref: string) => readEmbedBridge()?.navigate(ref),
        };

  const composerRef = useRef<ChatComposerHandle | null>(null);
  const navigate = useNavigate();
  const createEmbedThread = useAtomCommand(appsEnvironment.createEmbedThread, {
    reportFailure: false,
  });
  const [creating, setCreating] = useState(false);

  const openThread = (nextThreadId: string) =>
    void navigate({
      to: "/embed/$environmentId/$projectId/$threadId",
      params: { environmentId, projectId, threadId: nextThreadId },
    });
  // The server creates the thread for the app that owns this project, which is the only way the
  // host's appData can be set on it.
  const createThread = async (input: EmbedNewThread): Promise<string | null> => {
    setCreating(true);
    const result = await createEmbedThread({
      environmentId,
      input: { ...input, projectId },
    });
    setCreating(false);
    if (result._tag === "Success") return result.value.threadId;
    toastManager.add({ type: "error", title: "Couldn't start a new thread" });
    return null;
  };
  const closePanel = () => {
    if (shownThreadId !== null) {
      openThread(shownThreadId);
      return;
    }
    void navigate({
      to: "/embed/$environmentId/$projectId",
      params: { environmentId, projectId },
    });
  };
  const onHostCommand = useEffectEvent((command: Parameters<typeof runEmbedHostCommand>[0]) => {
    void runEmbedHostCommand(command, {
      composer: () => composerRef.current,
      openThread,
      createThread,
      openProviders: () =>
        void navigate({
          to: "/embed/$environmentId/$projectId/providers",
          params: { environmentId, projectId },
        }),
    });
  });
  useEffect(() => startEmbedBridge()?.subscribeHostCommands(onHostCommand), []);

  return (
    <AppReferencesContext value={appReferences}>
      <ComposerHandleContext value={composerRef}>
        <EmbedThreadReporter environmentId={environmentId} threadId={shownThreadId} />
        <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
          {panel === "providers" ? (
            <EmbedProvidersPanel
              environmentId={environmentId}
              projectId={projectId}
              onBack={closePanel}
            />
          ) : null}
          {switcher && panel === null ? (
            <EmbedThreadSwitcher
              threads={liveThreads}
              activeThreadId={shownThreadId}
              creating={creating}
              onSelect={openThread}
              onNewThread={() => {
                void createThread({}).then((created) => {
                  if (created !== null) openThread(created);
                });
              }}
            />
          ) : null}
          {panel !== null ? null : shownThreadId !== null ? (
            <ChatView environmentId={environmentId} threadId={shownThreadId} routeKind="server" />
          ) : (
            <p className="m-auto text-sm text-muted-foreground">No threads in this project yet.</p>
          )}
        </main>
      </ComposerHandleContext>
    </AppReferencesContext>
  );
}

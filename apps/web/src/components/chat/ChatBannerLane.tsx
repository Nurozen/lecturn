import type {
  EnvironmentId,
  OrchestrationV2ProviderFailureClass,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@lecturn/contracts";
import { useLayoutEffect, useRef, type Dispatch, type ReactNode, type SetStateAction } from "react";

import { observeResize } from "~/lib/observeResize";
import { ProviderStatusBanner } from "./ProviderStatusBanner";
import { dismissThreadErrorBannerForSession, ThreadErrorBanner } from "./ThreadErrorBanner";

/**
 * Thread banners float over the top of the timeline, where an app thread's closed or revoked
 * notice heads it, so the notice reserves the published lane height above itself. The space is
 * reserved inside the list rather than taken from it because the list re-pins to the end when it
 * resizes with the reader within a screen of the end, which would scroll the notice away.
 */
export function ChatBannerLaneFrame({ children }: { readonly children: ReactNode }) {
  const laneRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- observes the lane's DOM size and publishes its height as a CSS variable on the canvas
  useLayoutEffect(() => {
    const lane = laneRef.current;
    const canvas = lane?.parentElement;
    if (!lane || !canvas) return;
    const publish = () =>
      canvas.style.setProperty("--chat-banner-lane-height", `${lane.offsetHeight}px`);
    publish();
    const stop = observeResize(lane, publish);
    return () => {
      stop();
      canvas.style.removeProperty("--chat-banner-lane-height");
    };
  }, []);
  return (
    <div
      ref={laneRef}
      className="chat-banner-lane pointer-events-none absolute top-0 z-30 flex flex-col"
    >
      {children}
    </div>
  );
}

/**
 * The banners pinned above the timeline. The dismiss handlers are built here from plain
 * values, so a ChatView render that changes neither banner leaves both cached.
 */
export function ChatBannerLane(props: {
  providerStatus: ServerProvider | null;
  providerStatusBannerKey: string | null;
  setDismissedProviderStatusBannerKey: Dispatch<SetStateAction<string | null>>;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  environmentId: EnvironmentId;
  conversationProvider: ServerProvider | null;
  threadId: ThreadId;
  threadError: string | null;
  threadErrorClass: OrchestrationV2ProviderFailureClass | null;
  threadErrorCode: string | null;
  threadErrorBannerKey: string | null;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  setThreadErrorBannerDismissTick: Dispatch<SetStateAction<number>>;
}) {
  const {
    providerStatus,
    providerStatusBannerKey,
    setDismissedProviderStatusBannerKey,
    onOpenProviderSetup,
    environmentId,
    conversationProvider,
    threadId,
    threadError,
    threadErrorClass,
    threadErrorCode,
    threadErrorBannerKey,
    setThreadError,
    setThreadErrorBannerDismissTick,
  } = props;
  return (
    <ChatBannerLaneFrame>
      <ProviderStatusBanner
        status={providerStatus}
        onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
        onOpenProviderSetup={onOpenProviderSetup}
      />
      <ThreadErrorBanner
        environmentId={environmentId}
        provider={conversationProvider}
        error={threadError}
        errorClass={threadErrorClass}
        errorCode={threadErrorCode}
        onDismiss={() => {
          setThreadError(threadId, null);
          dismissThreadErrorBannerForSession(threadErrorBannerKey);
          setThreadErrorBannerDismissTick((tick) => tick + 1);
        }}
      />
    </ChatBannerLaneFrame>
  );
}

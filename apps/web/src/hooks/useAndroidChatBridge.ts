import { useEffect, useRef, useState } from "react";
import { androidChatSnapshot, createAndroidChatPublisher } from "../lib/androidChatWidget";

/**
 * Publishes the open conversation to the Android host's chat widget. Reads reply text, so it
 * lives beside the live timeline rows rather than in ChatView, which holds through text deltas.
 */
export function useAndroidChatPublisher({
  scope,
  thread,
}: {
  scope: string;
  thread: Parameters<typeof androidChatSnapshot>[0] | null;
}) {
  const publisher = useRef<{
    scope: string;
    client: ReturnType<typeof createAndroidChatPublisher>;
  } | null>(null);
  const pageActive = useRef(true);
  const current = useRef<{ scope: string; thread: typeof thread } | null>(null);
  const publishCurrent = () => {
    if (!pageActive.current || !current.current) return;
    const { scope, thread } = current.current;
    const host = window.symbaHost;
    if (host?.protocolVersion !== 2 || !host.publishChatWidget) return;
    if (publisher.current?.scope !== scope) {
      publisher.current?.client.close();
      const client = createAndroidChatPublisher(host);
      publisher.current = { scope, client };
      client.update(null);
    }
    publisher.current.client.update(thread ? androidChatSnapshot(thread) : null);
  };
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- publishes the current thread snapshot to the Android host chat bridge when the thread changes
  useEffect(() => {
    current.current = { scope, thread };
    publishCurrent();
  }, [scope, thread, publishCurrent]);
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- window listeners that close, reopen and refresh the Android chat publisher across page visibility
  useEffect(() => {
    const clear = () => {
      publisher.current?.client.close();
      publisher.current = null;
    };
    const hide = () => {
      pageActive.current = false;
      clear();
    };
    const show = () => {
      pageActive.current = true;
      publishCurrent();
    };
    const refresh = () => publisher.current?.client.refresh();
    window.addEventListener("lecturn:chat-visible", refresh);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("lecturn:chat-visible", refresh);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      clear();
    };
  }, [publishCurrent]);
}

/** Focuses the composer for the host's Reply action once the conversation is ready for one. */
export function useAndroidChatCompose({
  scope,
  ready,
  focusComposer,
}: {
  scope: string;
  ready: boolean;
  focusComposer: () => void;
}) {
  const [composeScope, setComposeScope] = useState<string | null>(null);
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- window listener for the Android host's compose request that schedules a composer focus frame
  useEffect(() => {
    if (!ready) return;
    let frame: number | undefined;
    const compose = () => {
      window.__lecturnComposeRequested = false;
      setComposeScope(scope);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(focusComposer);
    };
    window.addEventListener("lecturn:compose", compose);
    if (window.__lecturnComposeRequested) window.dispatchEvent(new Event("lecturn:compose"));
    return () => {
      window.removeEventListener("lecturn:compose", compose);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [focusComposer, ready, scope]);
  return composeScope === scope;
}

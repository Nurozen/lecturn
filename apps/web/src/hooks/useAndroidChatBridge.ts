import { useEffect, useRef, useState } from "react";
import { androidChatSnapshot, createAndroidChatPublisher } from "../lib/androidChatWidget";

export function useAndroidChatBridge({
  scope,
  thread,
  focusComposer,
}: {
  scope: string;
  thread: Parameters<typeof androidChatSnapshot>[0] | null;
  focusComposer: () => void;
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
  useEffect(() => {
    current.current = { scope, thread };
    publishCurrent();
  }, [scope, thread, publishCurrent]);
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
  const [composeScope, setComposeScope] = useState<string | null>(null);
  const composerReady = thread !== null;
  useEffect(() => {
    if (!composerReady) return;
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
  }, [composerReady, focusComposer, scope]);
  return composeScope === scope;
}

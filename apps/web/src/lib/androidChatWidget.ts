import type { AndroidChatWidgetSnapshot, AndroidHost } from "./androidHostAccess";

export function androidChatSnapshot(thread: {
  readonly id: string;
  readonly title: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
}): AndroidChatWidgetSnapshot | null {
  if (!thread.id.trim() || thread.id.length > 256) return null;
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (let i = thread.messages.length - 1; i >= 0 && messages.length < 6; i--) {
    const message = thread.messages[i];
    if (
      !message ||
      (message.role !== "user" && message.role !== "assistant") ||
      !message.text.trim()
    )
      continue;
    messages.unshift({
      role: message.role,
      text: message.text.length > 500 ? `${message.text.slice(0, 499)}…` : message.text,
    });
  }
  return { threadId: thread.id, title: thread.title.slice(0, 100), messages };
}

/** Coalesce streaming updates on a fixed cadence so continuous tokens cannot starve publication. */
export function createAndroidChatPublisher(host: AndroidHost) {
  let latest: AndroidChatWidgetSnapshot | null = null;
  let lastPublished: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let closed = false;
  let retries = 0;
  let generation = 0;
  const publish = async (snapshot: AndroidChatWidgetSnapshot | null) => {
    try {
      return (await host.publishChatWidget?.(snapshot))?.published === true;
    } catch {
      return false;
    }
  };
  const schedule = () => {
    if (closed || timer || busy) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 1500);
  };
  const flush = async () => {
    const snapshot = latest;
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastPublished || closed) return;
    busy = true;
    const publicationGeneration = generation;
    const accepted = await publish(snapshot);
    busy = false;
    if (closed) return;
    if (publicationGeneration !== generation) {
      if (latest !== null) schedule();
      return;
    }
    if (accepted) {
      lastPublished = serialized;
      retries = 0;
    } else retries++;
    if (JSON.stringify(latest) !== serialized || (!accepted && retries < 3)) schedule();
  };
  return {
    update(snapshot: AndroidChatWidgetSnapshot | null) {
      latest = snapshot;
      retries = 0;
      if (snapshot === null) {
        generation++;
        clearTimeout(timer);
        timer = undefined;
        lastPublished = undefined;
        void publish(null);
      } else schedule();
    },
    refresh() {
      generation++;
      lastPublished = undefined;
      retries = 0;
      schedule();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      void publish(null);
    },
  };
}

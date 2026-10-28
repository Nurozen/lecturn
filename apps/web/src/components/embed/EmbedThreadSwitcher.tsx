import { PlusIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export interface EmbedSwitcherThread {
  readonly id: string;
  readonly title: string;
}

/** The project's threads and New thread, for hosts that do not list threads themselves. */
export function EmbedThreadSwitcher({
  threads,
  activeThreadId,
  creating,
  onSelect,
  onNewThread,
}: {
  readonly threads: ReadonlyArray<EmbedSwitcherThread>;
  readonly activeThreadId: string | null;
  readonly creating: boolean;
  readonly onSelect: (threadId: string) => void;
  readonly onNewThread: () => void;
}) {
  const active = threads.find((thread) => thread.id === activeThreadId) ?? null;
  return (
    <div
      data-testid="embed-thread-switcher"
      className="flex min-w-0 shrink-0 items-center gap-1 border-b px-2 py-1"
    >
      <Select
        value={activeThreadId}
        onValueChange={(value) => {
          if (typeof value === "string" && value !== activeThreadId) onSelect(value);
        }}
      >
        <SelectTrigger
          variant="ghost"
          size="compact-fixed"
          className="min-w-0 flex-1"
          aria-label="Thread"
          disabled={threads.length === 0}
        >
          <SelectValue>{active?.title ?? "No thread"}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          {threads.map((thread) => (
            <SelectItem key={thread.id} hideIndicator value={thread.id}>
              {thread.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button variant="ghost" size="xs-fixed" disabled={creating} onClick={onNewThread}>
        <PlusIcon aria-hidden="true" />
        New thread
      </Button>
    </div>
  );
}

import type {
  EnvironmentId,
  PullRequestLinkedThreadsResult,
  ScopedProjectRef,
} from "@lecturn/contracts";

import { dispatchCommandPalette, isCommandPaletteMounted } from "./commandPaletteStore";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

export type CommandPaletteOpenDetail =
  | {
      readonly open?: "add-project" | "new-thread-in" | "open-app";
      readonly query?: string;
      readonly linkedThreads?: CommandPaletteLinkedThreads;
    }
  // Opens straight into the session picker for that project.
  | { readonly open: "import-session"; readonly projectRef: ScopedProjectRef };

export function openCommandPalette(detail: CommandPaletteOpenDetail = {}): void {
  // With no palette on screen (e.g. /pair) the request is dropped; kept in the
  // store, it would pop a stale palette once the app shell mounts.
  if (!isCommandPaletteMounted()) return;
  if (detail.open === "import-session") {
    dispatchCommandPalette({ _tag: "OpenImportSession", projectRef: detail.projectRef });
  } else if (detail.open === "open-app") {
    dispatchCommandPalette({ _tag: "OpenApp" });
  } else if (detail.open === "new-thread-in") {
    dispatchCommandPalette({ _tag: "OpenNewThreadIn" });
  } else if (detail.open === "add-project") {
    dispatchCommandPalette({ _tag: "OpenAddProject" });
  } else if (detail.query !== undefined) {
    dispatchCommandPalette({
      _tag: "OpenSearch",
      query: detail.query,
      ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
    });
  } else {
    dispatchCommandPalette({ _tag: "SetOpen", open: true });
  }
}

/** True while the palette popup is on screen, including its closing animation. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}

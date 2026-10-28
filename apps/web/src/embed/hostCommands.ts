import type { EmbedHostCommand } from "@lecturn/client-runtime/embed/guest";
import type { EmbedHostNotificationParams } from "@lecturn/contracts/embedBridge";

export type EmbedMention = EmbedHostNotificationParams<"lecturn/composer.insertMention">;
export type EmbedNewThread = EmbedHostNotificationParams<"lecturn/thread.new">;

export interface EmbedComposerTarget {
  readonly insertMention: (mention: EmbedMention) => void;
  readonly setDraft: (text: string) => void;
}

export interface EmbedHostCommandTargets {
  /** The composer on screen, if any; a command for a composer that is not mounted is dropped. */
  readonly composer: () => EmbedComposerTarget | null;
  readonly openThread: (threadId: string) => void;
  /** Asks the server for the thread, which it creates for the owning app; resolves its id. */
  readonly createThread: (input: EmbedNewThread) => Promise<string | null>;
  readonly openProviders: () => void;
}

export async function runEmbedHostCommand(
  command: EmbedHostCommand,
  targets: EmbedHostCommandTargets,
): Promise<void> {
  switch (command.method) {
    case "lecturn/composer.insertMention":
      targets.composer()?.insertMention(command.params);
      return;
    case "lecturn/composer.setDraft":
      targets.composer()?.setDraft(command.params.text);
      return;
    case "lecturn/thread.open":
      targets.openThread(command.params.threadId);
      return;
    case "lecturn/thread.new": {
      const threadId = await targets.createThread(command.params);
      if (threadId !== null) targets.openThread(threadId);
      return;
    }
    case "lecturn/providers.open":
      targets.openProviders();
      return;
  }
}

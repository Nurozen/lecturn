import {
  CommandId,
  MessageId,
  ThreadId,
  ThreadTurnStartCommand,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ServerProvider,
  type VcsStatusResult,
} from "@lecturn/contracts";
import {
  buildFactoryBranch,
  buildProviderFactoryPrompt,
  type FactorySourceId,
} from "@lecturn/client-runtime/providerFactory";
import * as Schema from "effect/Schema";
import type { FactoryForm, FactoryRunSummary } from "./FactoryView.types";

export const FACTORY_LAUNCH_KEY = "lecturn:provider-factory:launch:v1";
export type FactoryLaunchIntent = {
  readonly environmentId: EnvironmentId;
  readonly command: typeof ThreadTurnStartCommand.Type;
};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const decodeCommand = Schema.decodeUnknownSync(ThreadTurnStartCommand);

export function factoryProviderReady(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.status === "ready" &&
    provider.auth.status !== "unauthenticated"
  );
}

export function buildFactoryLaunch(input: {
  environmentId: EnvironmentId;
  project: OrchestrationProjectShell;
  provider: ServerProvider;
  form: FactoryForm;
  sourceId: FactorySourceId;
  uuid: string;
  createdAt: string;
}): FactoryLaunchIntent {
  const { project, provider, form } = input;
  if (project.stave)
    throw new Error(
      "Select an editable repository project, rather than a Stave space, to create an isolated worktree.",
    );
  if (!factoryProviderReady(provider))
    throw new Error("Choose an installed, ready execution provider.");
  if (provider.instanceId !== form.executorId)
    throw new Error("The selected provider changed. Select it again.");
  if (!provider.models.some((model) => model.slug === form.modelId))
    throw new Error("Choose a model available on this provider.");
  if (!form.baseBranch.trim()) throw new Error("Enter the base branch for the isolated worktree.");
  const branch = buildFactoryBranch(input.sourceId, input.uuid);
  const modelSelection = { instanceId: provider.instanceId, model: form.modelId };
  const threadId = ThreadId.make(input.uuid);
  return {
    environmentId: input.environmentId,
    command: {
      type: "thread.turn.start",
      commandId: CommandId.make(input.uuid),
      threadId,
      message: {
        messageId: MessageId.make(input.uuid),
        role: "user",
        attachments: [],
        text: buildProviderFactoryPrompt({
          sourceId: input.sourceId,
          branch,
          projectTitle: project.title,
          workspaceRoot: project.workspaceRoot,
          baseBranch: form.baseBranch.trim(),
          constraints: form.constraints,
        }),
      },
      modelSelection,
      runtimeMode: form.runtimeMode,
      interactionMode: "default",
      createdAt: input.createdAt,
      bootstrap: {
        createThread: {
          projectId: project.id,
          title: `Factory · ${input.sourceId} integration`,
          modelSelection,
          runtimeMode: form.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: input.createdAt,
        },
        prepareWorktree: {
          projectCwd: project.workspaceRoot,
          baseBranch: form.baseBranch.trim(),
          branch,
          startFromOrigin: true,
        },
        runSetupScript: true,
      },
    },
  };
}

export function readFactoryLaunch(storage: Storage): FactoryLaunchIntent | null {
  const saved = storage.getItem(FACTORY_LAUNCH_KEY);
  if (saved === null) return null;
  const parsed: unknown = JSON.parse(saved);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("environmentId" in parsed) ||
    typeof parsed.environmentId !== "string" ||
    !parsed.environmentId ||
    !("command" in parsed)
  ) {
    throw new Error("The saved Factory launch cannot be read. It will not be resent.");
  }
  return {
    environmentId: parsed.environmentId as EnvironmentId,
    command: decodeCommand(parsed.command),
  };
}

/** Bootstrap side effects precede server receipt deduplication. Never replay an uncertain launch. */
export async function sendFactoryLaunch(input: {
  storage: Storage;
  intent: FactoryLaunchIntent;
  send: (intent: FactoryLaunchIntent) => Promise<void>;
}): Promise<void> {
  if (input.storage.getItem(FACTORY_LAUNCH_KEY) !== null) {
    throw new Error(
      "A previous launch is awaiting confirmation. Inspect that run before launching again.",
    );
  }
  const savedIntent = JSON.stringify(input.intent);
  input.storage.setItem(FACTORY_LAUNCH_KEY, savedIntent);
  const clearOwnIntent = () => {
    if (input.storage.getItem(FACTORY_LAUNCH_KEY) === savedIntent) {
      input.storage.removeItem(FACTORY_LAUNCH_KEY);
    }
  };
  try {
    await input.send(input.intent);
  } catch (error) {
    // A typed server rejection is definitive. Transport failures remain uncertain.
    if (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      [
        "OrchestrationDispatchCommandError",
        "EnvironmentRpcUnavailableError",
        "EnvironmentAuthorizationError",
      ].includes(String(error._tag))
    ) {
      clearOwnIntent();
    }
    throw error;
  }
  clearOwnIntent();
}

export function factoryThreadStatus(
  thread: OrchestrationThreadShell,
): Pick<FactoryRunSummary, "statusLabel" | "statusTone"> {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput)
    return { statusLabel: "Needs attention", statusTone: "attention" };
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error")
    return { statusLabel: "Execution failed", statusTone: "error" };
  if (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "running" ||
    thread.backgroundLiveness === "working"
  )
    return { statusLabel: "Working", statusTone: "working" };
  if (thread.session?.status === "starting")
    return { statusLabel: "Starting", statusTone: "working" };
  if (thread.latestTurn?.state === "interrupted" || thread.session?.status === "interrupted")
    return { statusLabel: "Interrupted", statusTone: "attention" };
  if (thread.latestTurn?.state === "completed")
    return { statusLabel: "Turn completed", statusTone: "neutral" };
  return { statusLabel: "Awaiting execution", statusTone: "neutral" };
}

export function factoryPullRequest(
  thread: Pick<OrchestrationThreadShell, "branch" | "linkedPullRequest">,
  status: VcsStatusResult | null,
) {
  const linked = thread.linkedPullRequest;
  if (linked) return { label: `PR #${linked.number}`, url: linked.url };
  if (thread.branch !== null && status?.refName === thread.branch && status.pr) {
    return { label: `PR #${status.pr.number}`, url: status.pr.url };
  }
  return null;
}

export const FACTORY_UNCONFIRMED_KEY = "lecturn:provider-factory:unconfirmed:v1";

/** Retire only the browser lock. This neither cancels nor retries the original execution. */
export function releaseFactoryLaunch(storage: Storage, expectedRecord?: string | null): void {
  const rawRecord = storage.getItem(FACTORY_LAUNCH_KEY);
  if (expectedRecord !== undefined && rawRecord !== expectedRecord) {
    throw new Error(
      "The saved launch changed. Inspect the current record before releasing its lock.",
    );
  }
  if (rawRecord === null) return;
  let record: unknown;
  try {
    const intent = readFactoryLaunch(storage);
    if (!intent) return;
    record = {
      environmentId: intent.environmentId,
      threadId: intent.command.threadId,
      commandId: intent.command.commandId,
      branch: intent.command.bootstrap?.prepareWorktree?.branch ?? null,
      createdAt: intent.command.createdAt,
    };
  } catch {
    record = { kind: "unreadable-launch", rawRecord };
  }
  const savedAudit = storage.getItem(FACTORY_UNCONFIRMED_KEY);
  let audit: unknown[];
  try {
    const parsed: unknown = savedAudit === null ? [] : JSON.parse(savedAudit);
    audit = Array.isArray(parsed)
      ? parsed
      : [{ kind: "unreadable-history", rawRecord: savedAudit }];
  } catch {
    audit = [{ kind: "unreadable-history", rawRecord: savedAudit }];
  }
  storage.setItem(FACTORY_UNCONFIRMED_KEY, JSON.stringify([...audit, record]));
  storage.removeItem(FACTORY_LAUNCH_KEY);
}

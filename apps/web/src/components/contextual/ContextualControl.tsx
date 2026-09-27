import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import type { EnvironmentId, ThreadId } from "@lecturn/contracts";
import { SparklesIcon } from "lucide-react";
import { contextualStateLabel } from "@lecturn/client-runtime/state/contextual";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import {
  contextualEnvironment,
  contextualErrorMessage,
  useContextualAccess,
  useContextualAvailable,
} from "../../state/contextual";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";
import { ComposerControl } from "../chat/ComposerControl";
import { composerFloatingLayerProps } from "../chat/composerEventScope";
import { useComposerMenuState } from "../chat/useComposerMenuState";
import { ContextualHostSettings } from "./ContextualHostSettings";
import { ContextualProjectSettings } from "./ContextualProjectSettings";

export function ContextualControl({
  environmentId,
  threadId,
  size = "sm",
  hidden = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  size?: "sm" | "xs";
  hidden?: boolean;
}) {
  const available = useContextualAvailable(environmentId);
  const access = useContextualAccess(environmentId);
  const status = useEnvironmentQuery(
    available ? contextualEnvironment.status({ environmentId, input: { threadId } }) : null,
  );
  const update = useAtomCommand(contextualEnvironment.updateThreadSettings, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(contextualEnvironment.refresh, { reportFailure: false });
  const [open, setOpen] = useComposerMenuState(hidden);
  const [manage, setManage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const data = status.data;
  async function toggle(enabled: boolean, sourceIds = data?.thread.sourceIds) {
    if (!data || !sourceIds || !access.operate || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await update({
        environmentId,
        input: { threadId, expectedRevision: data.thread.revision, enabled, sourceIds },
      });
      if (r._tag === "Failure") setError(contextualErrorMessage(squashAtomCommandFailure(r)));
    } finally {
      setBusy(false);
    }
  }
  async function refreshContext() {
    if (!data || !access.operate || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await refresh({
        environmentId,
        input: { threadId, expectedRevision: data.thread.revision, actionId: randomUUID() },
      });
      if (r._tag === "Failure") setError(contextualErrorMessage(squashAtomCommandFailure(r)));
    } finally {
      setBusy(false);
    }
  }
  if (!available) return null;
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <ComposerControl
              size={size}
              disabled={!data}
              aria-label={`Contextual ${data?.thread.enabled ? "on" : "off"}`}
            />
          }
        >
          <SparklesIcon className="size-3.5" />
          Contextual · {data?.thread.enabled ? "On" : "Off"}
        </MenuTrigger>
        <MenuPopup align="start" {...composerFloatingLayerProps}>
          <MenuCheckboxItem
            checked={data?.thread.enabled ?? false}
            disabled={!access.operate || busy || !data}
            onCheckedChange={(value) => void toggle(value)}
          >
            Use Contextual
          </MenuCheckboxItem>
          <div className="max-w-72 px-2 py-2 text-xs text-muted-foreground">
            <p>
              {data
                ? contextualStateLabel(data.effective)
                : (status.error ?? "Loading context status…")}
            </p>
            <p className="mt-1">
              Collection on {data?.hostName ?? "this host"}:{" "}
              {data?.effective.collectionState ?? "unavailable"}. Paused collection keeps the
              permitted archive usable.
            </p>
          </div>
          <MenuSeparator />
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Project sources</div>
          {data?.project.sourceIds.map((id) => (
            <MenuCheckboxItem
              key={id}
              checked={data.thread.sourceIds.includes(id)}
              disabled={!access.operate || busy}
              onCheckedChange={(checked) =>
                void toggle(
                  data.thread.enabled,
                  checked
                    ? [...data.thread.sourceIds, id]
                    : data.thread.sourceIds.filter((source) => source !== id),
                )
              }
            >
              {data.permittedSources?.find((source) => source.id === id)?.label ??
                (id.startsWith("decisions:") ? "Saved Decisions" : id)}
            </MenuCheckboxItem>
          ))}
          {!data?.project.sourceIds.length ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">No sources selected</div>
          ) : null}
          <MenuSeparator />
          <MenuItem
            disabled={!access.operate || busy || !data?.thread.enabled}
            onClick={() => void refreshContext()}
          >
            Refresh context for next message
          </MenuItem>
          <MenuItem onClick={() => setManage(true)}>Manage sources…</MenuItem>
          {error ? (
            <p role="alert" className="max-w-72 px-2 py-1 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {!access.operate ? (
            <p className="max-w-72 px-2 py-1 text-xs text-muted-foreground">
              This connection has read-only thread access.
            </p>
          ) : null}
        </MenuPopup>
      </Menu>
      <Dialog open={manage} onOpenChange={setManage}>
        <DialogPopup className="max-w-3xl" {...composerFloatingLayerProps}>
          <DialogHeader>
            <DialogTitle>Contextual</DialogTitle>
            <DialogDescription>
              Sources and collection belong to {data?.hostName ?? "the selected host"}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-6">
            {data ? (
              <ContextualProjectSettings
                environmentId={environmentId}
                projectId={data.project.projectId}
              />
            ) : null}
            <ContextualHostSettings environmentId={environmentId} />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

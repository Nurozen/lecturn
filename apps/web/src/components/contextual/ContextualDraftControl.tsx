import type { DraftId } from "../../composerDraftStore";
import type { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { useState } from "react";
import { contextualDraftKey, useContextualDrafts } from "../../state/contextualDrafts";
import {
  contextualEnvironment,
  useContextualAccess,
  useContextualAvailable,
} from "../../state/contextual";
import { useEnvironmentQuery } from "../../state/query";
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ComposerControl } from "../chat/ComposerControl";
import { composerFloatingLayerProps } from "../chat/composerEventScope";
import { useComposerMenuState } from "../chat/useComposerMenuState";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from "../ui/dialog";
import { ContextualProjectSettings } from "./ContextualProjectSettings";
import { ContextualHostSettings } from "./ContextualHostSettings";
export function ContextualDraftControl({
  environmentId,
  projectId,
  draftId,
  size = "sm",
  hidden = false,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  draftId: DraftId;
  size?: "xs" | "sm";
  hidden?: boolean;
}) {
  const available = useContextualAvailable(environmentId),
    access = useContextualAccess(environmentId);
  const project = useEnvironmentQuery(
    available
      ? contextualEnvironment.projectSettings({ environmentId, input: { projectId } })
      : null,
  );
  const key = contextualDraftKey(environmentId, projectId, draftId);
  const choice = useContextualDrafts((state) => state.choices[key]);
  const set = useContextualDrafts((state) => state.set);
  const enabled = choice?.enabled ?? project.data?.defaultEnabled ?? false;
  const [open, setOpen] = useComposerMenuState(hidden),
    [manage, setManage] = useState(false);
  if (!available) return null;
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <ComposerControl
              size={size}
              disabled={!project.data}
              aria-label={`Contextual ${enabled ? "on" : "off"} for new thread`}
            />
          }
        >
          Contextual · {enabled ? "On" : "Off"}
        </MenuTrigger>
        <MenuPopup align="start" {...composerFloatingLayerProps}>
          <MenuCheckboxItem
            checked={enabled}
            disabled={!access.operate || !project.data}
            onCheckedChange={(next) =>
              set(key, {
                enabled: next,
                sourceIds: choice?.sourceIds ?? project.data?.sourceIds ?? [],
              })
            }
          >
            Use Contextual
          </MenuCheckboxItem>
          <p className="max-w-64 px-2 py-2 text-xs text-muted-foreground">
            {choice
              ? "Applies to this new thread from its first message."
              : "Following this project’s default for new threads."}{" "}
            Sources are collected on the selected host.
          </p>
          <MenuItem onClick={() => set(key, null)} disabled={!choice}>
            Use project default
          </MenuItem>
          <MenuItem onClick={() => setManage(true)}>Manage sources…</MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={manage} onOpenChange={setManage}>
        <DialogPopup className="max-w-3xl" {...composerFloatingLayerProps}>
          <DialogHeader>
            <DialogTitle>Contextual for this project</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-6">
            <ContextualProjectSettings environmentId={environmentId} projectId={projectId} />
            <ContextualHostSettings environmentId={environmentId} />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

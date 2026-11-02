import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@lecturn/client-runtime/state/runtime";
import { squireRoomTtlLabel } from "@lecturn/client-runtime/state/squire";
import type { SquireId } from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { randomUUID } from "../../../lib/utils";
import { serverEnvironment } from "../../../state/server";
import { squireEnvironment, useSquireEnvironmentState } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { commandFailureMessage } from "../queue/SquireEvidenceCard";
import { SquirePortrait } from "../SquireHeader";
import { SQUIRE_MEMBER_FULL_COLOR } from "./SquireRoomPortraits";
import {
  SQUIRE_ROOM_MAX_MEMBERS,
  squireRoomCreateProblem,
  squireRoomTtlOptions,
} from "./squireRooms.logic";
import {
  closeSquireRoomCreate,
  useSquireRoomCreateTarget,
  type SquireRoomCreateTarget,
} from "./squireRoomStore";

// Below 22 px SquireIndicator draws the mark instead of the portrait (P16.4).
const PORTRAIT_PX = 24;

/** Mounted once in AppShell; opens from `openSquireRoomCreate`. */
export function SquireRoomCreateHost() {
  const target = useSquireRoomCreateTarget();
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) closeSquireRoomCreate();
      }}
    >
      {target === null ? null : (
        <SquireRoomCreateForm
          key={`${target.environmentId}:${target.members?.join(",") ?? ""}`}
          target={target}
        />
      )}
    </Dialog>
  );
}

function SquireRoomCreateForm(props: { readonly target: SquireRoomCreateTarget }) {
  const { environmentId } = props.target;
  const state = useSquireEnvironmentState(environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canCreate = useAtomValue(squireEnvironment.roomCreate.permissionAtom(environmentId));
  const create = useAtomCommand(squireEnvironment.roomCreate, { reportFailure: false });
  const navigate = useNavigate();
  const defaultTtl = config?.settings.squire.roomIdleTtlHours ?? 24;
  const [members, setMembers] = useState<ReadonlyArray<SquireId>>(() => props.target.members ?? []);
  const [includeLead, setIncludeLead] = useState(false);
  const [topic, setTopic] = useState("");
  const [ttlHours, setTtlHours] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const squires = (state?.squires ?? []).filter((entry) => entry.squire.role === "squire");
  const lead = state?.squires.find((entry) => entry.squire.id === state.lead) ?? null;
  const ttl = ttlHours ?? defaultTtl;
  const problem = squireRoomCreateProblem({ topic, memberCount: members.length });

  const toggle = (squireId: SquireId, checked: boolean) => {
    setError(null);
    setMembers((current) =>
      checked ? [...current, squireId] : current.filter((id) => id !== squireId),
    );
  };

  const submit = async () => {
    if (problem !== null || pending) return;
    setPending(true);
    setError(null);
    const result = await create({
      environmentId,
      input: {
        requestId: randomUUID(),
        topic: topic.trim(),
        members,
        includesLead: includeLead,
        ...(props.target.about === undefined || props.target.about.length === 0
          ? {}
          : { about: props.target.about }),
        ...(ttl === defaultTtl ? {} : { idleTtlHours: ttl }),
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(commandFailureMessage(result, "The room could not be opened. Try again."));
      }
      return;
    }
    closeSquireRoomCreate();
    void navigate({
      to: "/squires/$environmentId/rooms/$roomId",
      params: { environmentId, roomId: result.value.room.id },
    });
  };

  return (
    <DialogPopup className="max-w-md">
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>New room</DialogTitle>
          <DialogDescription>
            Squires talk it through here. Each post wakes only the members it is meant for.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="squire-room-topic">Topic</Label>
            <Input
              id="squire-room-topic"
              value={topic}
              maxLength={120}
              placeholder="Release 4.2 blockers"
              onChange={(event) => setTopic(event.target.value)}
            />
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1.5 text-sm font-medium">
              Squires{" "}
              <span className="font-normal text-muted-foreground">
                ({members.length} of 2 to {SQUIRE_ROOM_MAX_MEMBERS})
              </span>
            </legend>
            {squires.length === 0 ? (
              <p className="text-sm text-muted-foreground">No Squires yet.</p>
            ) : (
              squires.map((entry) => {
                const checked = members.includes(entry.squire.id);
                const paused = entry.squire.status !== "active";
                return (
                  <label
                    key={entry.squire.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-64"
                  >
                    <Checkbox
                      checked={checked}
                      disabled={paused || (!checked && members.length >= SQUIRE_ROOM_MAX_MEMBERS)}
                      onCheckedChange={(next) => toggle(entry.squire.id, next)}
                    />
                    <span className={`flex ${SQUIRE_MEMBER_FULL_COLOR}`}>
                      <SquirePortrait
                        environmentId={environmentId}
                        entry={entry}
                        size={PORTRAIT_PX}
                        label={entry.squire.name}
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{entry.squire.name}</span>
                    {paused ? <span className="text-xs text-muted-foreground">paused</span> : null}
                  </label>
                );
              })
            )}
            {lead === null ? null : (
              <label className="mt-1 flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm">
                <Checkbox checked={includeLead} onCheckedChange={setIncludeLead} />
                <span>Include {lead.squire.name}</span>
              </label>
            )}
          </fieldset>
          <div className="flex items-center justify-between gap-3">
            <Label>Close after idle</Label>
            <Select
              value={String(ttl)}
              onValueChange={(value) => {
                if (value !== null) setTtlHours(Number(value));
              }}
            >
              <SelectTrigger size="sm" aria-label="Close after idle" className="w-32">
                <SelectValue>{(value: string) => squireRoomTtlLabel(Number(value))}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {squireRoomTtlOptions(ttl).map((hours) => (
                  <SelectItem key={hours} value={String(hours)}>
                    {squireRoomTtlLabel(hours)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={closeSquireRoomCreate}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!canCreate || problem !== null || pending}
            title={problem ?? undefined}
          >
            Open room
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}

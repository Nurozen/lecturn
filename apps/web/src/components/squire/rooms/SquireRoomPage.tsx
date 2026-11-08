import { useAtomValue } from "@effect/atom-react";
import {
  SQUIRE_ROOM_PORTRAIT_CAP,
  squireRoomNameOf,
  squireRoomPostsInput,
  squireRoomTtlHours,
  squireRoomTtlLabel,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  SquireId,
  SquireRoom,
  SquireRoomId,
  SquireRoomPostId,
  SquireRoomRow,
  SquireRoomUpdateInput,
} from "@lecturn/contracts";
import { BellOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../../env";
import { randomUUID } from "../../../lib/utils";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { squireEnvironment, useSquireEnvironmentState } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { SidebarInset } from "../../ui/sidebar";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { Toggle } from "../../ui/toggle";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../../WorkspacePageHeader";
import { commandFailureMessage } from "../squireCommandFailure";
import { SquireRoomComposer } from "./SquireRoomComposer";
import { SquireRoomLog, type SquireRoomLogContext } from "./SquireRoomLog";
import { SquireRoomPortraits } from "./SquireRoomPortraits";
import { squireRoomTtlOptions } from "./squireRooms.logic";
import { markSquireRoomSeen } from "./squireRoomSeen";

const HEADER_PORTRAIT_PX = 28;
/** Within this many pixels of the end, a new post keeps the log pinned to it. */
const PINNED_SLACK_PX = 80;

export function SquireRoomPage(props: {
  readonly environmentId: EnvironmentId;
  readonly roomId: SquireRoomId;
}) {
  const { environmentId, roomId } = props;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const state = useSquireEnvironmentState(environmentId);
  const row = state?.rooms.find((room) => room.id === roomId) ?? null;
  const unavailable = config != null && config.environment.capabilities.squire !== true;

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel="Squire room" className="min-w-0 flex-1">
          <WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbText>Squires</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>
            <WorkspaceBreadcrumbText>{row?.topic ?? "Room"}</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      {state !== null && row !== null ? (
        <SquireRoomView
          environmentId={environmentId}
          row={row}
          squires={state.squires}
          leadId={state.lead}
        />
      ) : unavailable || state !== null ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Room not available</EmptyTitle>
            <EmptyDescription>
              This room was removed, or its environment does not run Squires.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </SidebarInset>
  );
}

function SquireRoomView(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SquireRoomRow;
  readonly squires: ReadonlyArray<SquireSnapshotEntry>;
  readonly leadId: SquireId | null;
}) {
  const { environmentId, row, squires, leadId } = props;
  const newest = useEnvironmentQuery(
    squireEnvironment.roomPosts({ environmentId, input: squireRoomPostsInput(row.id, null) }),
  );
  const canMarkRead = useAtomValue(squireEnvironment.roomMarkRead.permissionAtom(environmentId));
  const markRead = useAtomCommand(squireEnvironment.roomMarkRead, { reportFailure: false });
  const [earlierPages, setEarlierPages] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const markedRef = useRef<SquireRoomPostId | null>(null);

  const room = newest.data?.room ?? null;
  const newestPostId = newest.data?.posts[0]?.id ?? null;
  const lastPostAt = room?.lastPostAt ?? null;

  // The newest page is on screen once loaded, since the log opens pinned to its end.
  useEffect(() => {
    if (newestPostId === null) return;
    markSquireRoomSeen(environmentId, row.id, lastPostAt);
    if (!canMarkRead || markedRef.current === newestPostId) return;
    markedRef.current = newestPostId;
    void markRead({
      environmentId,
      input: { requestId: randomUUID(), roomId: row.id, throughPostId: newestPostId },
    });
  }, [environmentId, row.id, newestPostId, lastPostAt, canMarkRead, markRead]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || newestPostId === null || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [newestPostId]);

  const nameOf = squireRoomNameOf(squires);
  const lead = squires.find((entry) => entry.squire.id === leadId) ?? null;
  const members = row.members.map((squireId) => ({ squireId, name: nameOf(squireId) }));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SquireRoomHeader
        environmentId={environmentId}
        row={row}
        room={room}
        squires={squires}
        memberNames={[
          ...members.map((member) => member.name),
          ...(row.includesLead && lead !== null ? [lead.squire.name] : []),
        ]}
      />
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_SLACK_PX;
        }}
      >
        {room === null || newest.data === null ? (
          newest.error === null ? null : (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">
              The room could not be loaded.
            </p>
          )
        ) : (
          <SquireRoomLog
            context={
              {
                environmentId,
                room,
                squires,
                leadId,
                nameOf,
                onLoadEarlier: () => {
                  pinnedRef.current = false;
                  setEarlierPages(earlierPages + 1);
                },
              } satisfies SquireRoomLogContext
            }
            posts={newest.data.posts}
            nextBefore={newest.data.nextBefore}
            earlierPages={earlierPages}
          />
        )}
      </div>
      <SquireRoomComposer
        environmentId={environmentId}
        roomId={row.id}
        members={members}
        lead={lead === null ? null : { squireId: lead.squire.id, name: lead.squire.name }}
        closed={row.status === "closed"}
      />
    </div>
  );
}

type RoomPatch = Omit<
  typeof SquireRoomUpdateInput.Type,
  "requestId" | "roomId" | "expectedRevision"
>;

function SquireRoomHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SquireRoomRow;
  /** The full record, whose revision every edit needs; null until the log loads. */
  readonly room: SquireRoom | null;
  readonly squires: ReadonlyArray<SquireSnapshotEntry>;
  readonly memberNames: ReadonlyArray<string>;
}) {
  const { environmentId, row, room } = props;
  const canUpdate = useAtomValue(squireEnvironment.roomUpdate.permissionAtom(environmentId));
  const canClose = useAtomValue(squireEnvironment.roomClose.permissionAtom(environmentId));
  const canReopen = useAtomValue(squireEnvironment.roomReopen.permissionAtom(environmentId));
  const update = useAtomCommand(squireEnvironment.roomUpdate, { reportFailure: false });
  const close = useAtomCommand(squireEnvironment.roomClose, { reportFailure: false });
  const reopen = useAtomCommand(squireEnvironment.roomReopen, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const closed = row.status === "closed";
  const editable = canUpdate && room !== null && !pending;

  const report = (
    result: Awaited<ReturnType<typeof update>> | Awaited<ReturnType<typeof close>>,
  ) => {
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: commandFailureMessage(result, "The room could not be updated. Try again."),
      });
    }
  };

  const patch = async (change: RoomPatch) => {
    if (room === null) return;
    setPending(true);
    const result = await update({
      environmentId,
      input: {
        requestId: randomUUID(),
        roomId: row.id,
        expectedRevision: room.revision,
        ...change,
      },
    });
    setPending(false);
    report(result);
  };

  const toggleOpen = async () => {
    setPending(true);
    const input = { requestId: randomUUID(), roomId: row.id };
    const result = closed
      ? await reopen({ environmentId, input })
      : await close({ environmentId, input });
    setPending(false);
    report(result);
  };

  const ttl = room === null ? null : squireRoomTtlHours(room);

  return (
    <div className="flex flex-col gap-3 border-b px-6 pt-2 pb-3">
      <div className="flex min-w-0 items-center gap-3">
        <SquireRoomPortraits
          environmentId={environmentId}
          portraits={row.members.slice(0, SQUIRE_ROOM_PORTRAIT_CAP)}
          overflow={Math.max(0, row.members.length - SQUIRE_ROOM_PORTRAIT_CAP)}
          squires={props.squires}
          size={HEADER_PORTRAIT_PX}
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{row.topic}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {props.memberNames.join(", ")}
            {closed ? ` · Closed${room?.closedReason ? `: ${room.closedReason}` : ""}` : ""}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <Switch
            size="sm"
            checked={room?.botMessaging ?? true}
            disabled={!editable || closed}
            onCheckedChange={(botMessaging) => void patch({ botMessaging })}
          />
          Bot messaging
        </label>
        <Toggle
          size="xs-label"
          variant="outline"
          pressed={row.muted}
          disabled={!editable}
          onPressedChange={(muted) => void patch({ muted })}
        >
          <BellOffIcon />
          {row.muted ? "Muted" : "Mute"}
        </Toggle>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Close after idle</span>
          <Select
            value={ttl === null ? null : String(ttl)}
            disabled={!editable || closed}
            onValueChange={(value) => {
              if (value !== null && Number(value) !== ttl)
                void patch({ idleTtlHours: Number(value) });
            }}
          >
            <SelectTrigger size="xs" aria-label="Close after idle" className="w-24">
              <SelectValue>
                {(value: string | null) =>
                  value === null ? "…" : squireRoomTtlLabel(Number(value))
                }
              </SelectValue>
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
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          disabled={pending || !(closed ? canReopen : canClose)}
          onClick={() => void toggleOpen()}
        >
          {closed ? "Reopen" : "Close room"}
        </Button>
      </div>
    </div>
  );
}

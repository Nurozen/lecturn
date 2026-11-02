import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireRoomId, SquireRoomRow } from "@lecturn/contracts";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { memo } from "react";

import { SidebarMenuSubButton, SidebarMenuSubItem, useSidebar } from "../../ui/sidebar";
import { squireRoomSidebarRows } from "./squireRooms.logic";
import { SquireRoomPortraits } from "./SquireRoomPortraits";
import { useSquireRoomSeen } from "./squireRoomSeen";

// The smallest size SquireIndicator still draws a portrait at (P16.4), as on the Squire rows.
const PORTRAIT_PX = 22;

const selectRoomKey = (match: { params: { environmentId: string; roomId: string } }) =>
  `${match.params.environmentId}\n${match.params.roomId}`;

/** P19.8 open rooms nested under the Lead, after its Squires. */
export const SquireRoomRows = memo(function SquireRoomRows(props: {
  readonly environmentId: EnvironmentId;
  readonly rooms: ReadonlyArray<SquireRoomRow>;
  readonly squires: ReadonlyArray<SquireSnapshotEntry>;
}) {
  const { environmentId } = props;
  const seen = useSquireRoomSeen(environmentId);
  const activeKey = useMatch({
    from: "/_chat/squires/$environmentId/rooms/$roomId",
    shouldThrow: false,
    select: selectRoomKey,
  });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const rows = squireRoomSidebarRows(props.rooms, seen);
  if (rows.length === 0) return null;

  const open = (roomId: SquireRoomId) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/squires/$environmentId/rooms/$roomId",
      params: { environmentId, roomId },
    });
  };

  return (
    <ul data-testid="squire-sidebar-rooms" className="flex min-w-0 flex-col gap-1 pl-5">
      {rows.map((row) => {
        const active = activeKey === `${environmentId}\n${row.id}`;
        return (
          <SidebarMenuSubItem key={row.id}>
            <SidebarMenuSubButton
              size="sm"
              isActive={active}
              aria-current={active ? "page" : undefined}
              aria-label={`Room: ${row.topic}${row.unread ? ", unread" : ""}`}
              data-testid="squire-sidebar-room"
              data-room-id={row.id}
              render={<button type="button" />}
              className="w-full"
              onClick={() => open(row.id)}
            >
              <SquireRoomPortraits
                environmentId={environmentId}
                portraits={row.portraits}
                overflow={row.overflow}
                squires={props.squires}
                size={PORTRAIT_PX}
                fullColor
              />
              <span className="min-w-0 flex-1 truncate">{row.topic}</span>
              {row.unread ? (
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
              ) : null}
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        );
      })}
    </ul>
  );
});

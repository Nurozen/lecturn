import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { memo } from "react";

import { squireEnvironment, useSquireEnvironmentState } from "../../../state/squires";
import { Button } from "../../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import { squireRoomMenuGroups } from "./squireRooms.logic";
import { openSquireRoomCreate } from "./squireRoomStore";

/** The Lead view's Rooms menu (open and closed rooms) plus New room. */
export const SquireRoomsMenu = memo(function SquireRoomsMenu(props: {
  readonly environmentId: EnvironmentId;
}) {
  const { environmentId } = props;
  const state = useSquireEnvironmentState(environmentId);
  const canCreate = useAtomValue(squireEnvironment.roomCreate.permissionAtom(environmentId));
  const navigate = useNavigate();
  if (state === null) return null;
  const { open, closed } = squireRoomMenuGroups(state.rooms);
  if (open.length === 0 && closed.length === 0 && !canCreate) return null;
  const go = (roomId: (typeof state.rooms)[number]["id"]) =>
    void navigate({
      to: "/squires/$environmentId/rooms/$roomId",
      params: { environmentId, roomId },
    });

  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="ghost" data-testid="squire-rooms-menu" />}>
        <MessagesSquareIcon aria-hidden />
        Rooms
      </MenuTrigger>
      <MenuPopup align="end">
        {open.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Open</MenuGroupLabel>
            {open.map((room) => (
              <MenuItem key={room.id} onClick={() => go(room.id)}>
                <span className="min-w-0 flex-1 truncate">{room.topic}</span>
                {room.unread ? (
                  <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-info" />
                ) : null}
              </MenuItem>
            ))}
          </MenuGroup>
        ) : null}
        {closed.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Closed</MenuGroupLabel>
            {closed.map((room) => (
              <MenuItem key={room.id} onClick={() => go(room.id)}>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{room.topic}</span>
              </MenuItem>
            ))}
          </MenuGroup>
        ) : null}
        {canCreate ? (
          <>
            {open.length > 0 || closed.length > 0 ? <MenuSeparator /> : null}
            <MenuItem onClick={() => openSquireRoomCreate({ environmentId })}>New room</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

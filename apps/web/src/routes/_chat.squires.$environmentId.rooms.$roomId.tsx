import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, SquireRoomId } from "@lecturn/contracts";

import { SquireRoomPage } from "../components/squire/rooms/SquireRoomPage";

export const Route = createFileRoute("/_chat/squires/$environmentId/rooms/$roomId")({
  component: function SquireRoomRoute() {
    const params = Route.useParams();
    return (
      <SquireRoomPage
        key={`${params.environmentId}:${params.roomId}`}
        environmentId={EnvironmentId.make(params.environmentId)}
        roomId={SquireRoomId.make(params.roomId)}
      />
    );
  },
});

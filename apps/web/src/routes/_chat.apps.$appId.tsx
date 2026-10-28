import { isAppId } from "@lecturn/shared/appLinks";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { showSidebarMode } from "../components/apps/sidebarMode";

/**
 * `lecturn://apps/<appId>` lands here: the sidebar opens on that app and the main area is the
 * index, as when Lecturn opens. Preloads only look; they never switch the sidebar.
 */
export const Route = createFileRoute("/_chat/apps/$appId")({
  beforeLoad: ({ params, preload }) => {
    if (!preload && isAppId(params.appId)) showSidebarMode({ mode: "apps", appId: params.appId });
    throw redirect({ to: "/", replace: true });
  },
});

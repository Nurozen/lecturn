import { createFileRoute } from "@tanstack/react-router";

import { ConnectedAppsSettings } from "../components/settings/ConnectedAppsSettings";

export const Route = createFileRoute("/_chat/settings/apps")({
  component: ConnectedAppsSettings,
});

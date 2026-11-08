import { EnvironmentId, SquireId } from "@lecturn/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { SquiresSettings } from "../components/squire/SquiresSettings";

function SettingsSquiresRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SquiresSettings
      squire={search.squire}
      environmentId={search.environmentId}
      onEnvironmentChange={(environmentId) =>
        void navigate({ search: { environmentId }, replace: true })
      }
    />
  );
}

export const Route = createFileRoute("/_chat/settings/squires")({
  validateSearch: (
    raw: Record<string, unknown>,
  ): { squire?: SquireId; environmentId?: EnvironmentId } => ({
    ...(typeof raw.squire === "string" && raw.squire !== ""
      ? { squire: SquireId.make(raw.squire) }
      : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId !== ""
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
  }),
  component: SettingsSquiresRoute,
});

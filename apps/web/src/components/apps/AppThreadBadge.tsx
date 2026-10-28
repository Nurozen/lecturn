import type { EnvironmentProject } from "@lecturn/client-runtime/state/shell";

import { useAppEmbedContext } from "../../state/apps";
import { Badge } from "../ui/badge";

/**
 * Marks an app thread where it shows up outside Apps mode (search results), so
 * a thread whose project is not in the Projects list still says where it lives.
 */
export function AppThreadBadge({
  project,
}: {
  readonly project: Pick<EnvironmentProject, "environmentId" | "id" | "appBinding"> | null;
}) {
  const binding = project?.appBinding;
  const context = useAppEmbedContext(
    project && binding ? { environmentId: project.environmentId, projectId: project.id } : null,
  );
  if (!binding) return null;
  return (
    <Badge variant="outline" size="sm" data-testid="app-thread-badge">
      {context?.iconDataUrl ? <img src={context.iconDataUrl} alt="" className="size-3" /> : null}
      {context?.name ?? binding.appId}
    </Badge>
  );
}

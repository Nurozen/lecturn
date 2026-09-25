import { continueSessionLinkLabel } from "@lecturn/client-runtime/external-session-import";
import type { ScopedProjectRef } from "@lecturn/contracts";
import { useMemo } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useServerConfigs } from "~/state/entities";
import { listImportCapableProviders } from "../ImportSessionPalette.logic";

/**
 * The new-thread screen's quiet way into the import picker, scoped to the
 * draft's project. Renders from the server config alone; sessions are listed
 * only once the picker opens.
 */
export function DraftImportSessionLink({ projectRef }: { readonly projectRef: ScopedProjectRef }) {
  const serverConfig = useServerConfigs().get(projectRef.environmentId);
  const driverKinds = useMemo(
    () =>
      listImportCapableProviders({
        supportsForking: serverConfig?.environment.capabilities.threadForking === true,
        providers: serverConfig?.providers ?? [],
      }).map((provider) => provider.driver),
    [serverConfig],
  );
  if (driverKinds.length === 0) return null;
  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={() => openCommandPalette({ open: "import-session", projectRef })}
        className="cursor-pointer rounded-sm text-muted-foreground/70 text-xs transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        {continueSessionLinkLabel(driverKinds)}
      </button>
    </div>
  );
}

import { useAtomValue } from "@effect/atom-react";
import { continueSessionLinkLabel } from "@lecturn/client-runtime/external-session-import";
import type { ScopedProjectRef } from "@lecturn/contracts";

import { openCommandPalette } from "~/commandPaletteBus";
import { useServerConfigs } from "~/state/entities";
import { providersIgnoringCheckedAtAtom } from "~/state/server";
import { listImportCapableProviders } from "../ImportSessionPalette.logic";

/**
 * The new-thread screen's quiet way into the import picker, scoped to the
 * draft's project. Renders from the server config and provider statuses; sessions are listed
 * only once the picker opens.
 */
export function DraftImportSessionLink({ projectRef }: { readonly projectRef: ScopedProjectRef }) {
  const serverConfig = useServerConfigs().get(projectRef.environmentId);
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(projectRef.environmentId));
  const driverKinds = listImportCapableProviders({
    supportsForking: serverConfig?.environment.capabilities.threadForking === true,
    providers,
  }).map((provider) => provider.driver);
  if (driverKinds.length === 0) return null;
  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={() => openCommandPalette({ open: "import-session", projectRef })}
        className="cursor-pointer rounded-sm text-muted-foreground/70 text-xs transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {continueSessionLinkLabel(driverKinds)}
      </button>
    </div>
  );
}

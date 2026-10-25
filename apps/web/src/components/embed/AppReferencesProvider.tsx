import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@lecturn/contracts";
import { expandAppOpenUrl } from "@lecturn/shared/appReferences";
import type { ReactNode } from "react";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { openAppUrl } from "../../lib/openAppUrl";
import { useAppEmbedContext } from "../../state/apps";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { AppReferencesContext } from "./AppReferencesContext";

/**
 * App references in a full Lecturn thread. Only threads of an app-bound project subscribe to the
 * app's context, and the app opens only from the machine it runs on.
 */
export function AppReferencesProvider({
  environmentId,
  threadId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly children: ReactNode;
}) {
  const shell = useQuietThreadShell(scopeThreadRef(environmentId, threadId));
  const projectRef = shell === null ? null : scopeProjectRef(environmentId, shell.projectId);
  const binding = useProject(projectRef)?.appBinding ?? null;
  const context = useAppEmbedContext(binding === null ? null : projectRef);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const local = !isLocalEnvironmentDisabled() && environmentId === primaryEnvironmentId;

  const template = context?.openUrlTemplate ?? null;
  const value =
    context === null || binding === null
      ? null
      : {
          refPrefixes: context.refPrefixes,
          iconUrl: context.iconDataUrl,
          activate:
            template === null || !local
              ? null
              : (ref: string) => {
                  const url = expandAppOpenUrl(template, {
                    workspaceRoot: binding.workspaceRoot,
                    threadId,
                    ref,
                  });
                  if (url !== null) openAppUrl(url);
                },
        };
  return <AppReferencesContext value={value}>{children}</AppReferencesContext>;
}

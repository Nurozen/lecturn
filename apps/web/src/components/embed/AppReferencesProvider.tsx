import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@lecturn/contracts";
import { expandAppOpenUrl } from "@lecturn/shared/appReferences";
import type { ReactNode } from "react";

import { openAppUrl } from "../../lib/openAppUrl";
import { useCanOpenApp } from "../apps/useAppClosedBanner";
import { useAppEmbedContext } from "../../state/apps";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { AppReferencesContext } from "./AppReferencesContext";
import { AppRefStoredLabels, appRefLabelScope } from "./AppRefStoredLabels";

/**
 * App references in a full Lecturn thread. Only threads of an app-bound project subscribe to the
 * app's context, and the app opens only from the machine it runs on. Chips show the labels their
 * messages stored; with no host to ask, any other reference shows as itself.
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
  const canOpenApp = useCanOpenApp(environmentId);

  const template = context?.openUrlTemplate ?? null;
  const value =
    context === null || binding === null
      ? null
      : {
          refPrefixes: context.refPrefixes,
          iconUrl: context.iconDataUrl,
          labelScope: appRefLabelScope(environmentId, threadId),
          activate:
            template === null || !canOpenApp
              ? null
              : (ref: string) => {
                  const url = expandAppOpenUrl(template, {
                    workspaceRoot: binding.workspaceRoot,
                    threadId,
                    ref,
                  });
                  if (url !== null) openAppUrl(url, template);
                },
        };
  return (
    <AppReferencesContext value={value}>
      {value === null ? null : (
        <AppRefStoredLabels environmentId={environmentId} threadId={threadId} />
      )}
      {children}
    </AppReferencesContext>
  );
}

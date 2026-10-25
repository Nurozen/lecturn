import type { AppBinding, AppEmbedContext, ScopedProjectRef, ThreadId } from "@lecturn/contracts";
import { expandAppOpenUrl } from "@lecturn/shared/appReferences";
import { ExternalLinkIcon, UnplugIcon } from "lucide-react";
import { createElement } from "react";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { openAppUrl } from "../../lib/openAppUrl";
import { useRemoteOpenResolution } from "../../remoteOpen";
import { useAppEmbedContext } from "../../state/apps";
import { useProject } from "../../state/entities";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";
import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";

export interface AppClosedBanner {
  readonly appId: string;
  readonly title: string;
  readonly openLabel: string;
  readonly openUrl: string | null;
}

/**
 * Closed means granted with no live lease. A revoked or unpaired app has no tools at all, so
 * "closed" would mislead; the lease's expiry is not compared with the clock because renewals are
 * not broadcast and the server reports a lost lease itself.
 */
export function appClosedBanner(input: {
  readonly context: AppEmbedContext | null;
  readonly binding: AppBinding | null;
  readonly threadId: ThreadId | null;
  readonly canOpenApp: boolean;
}): AppClosedBanner | null {
  const { context, binding } = input;
  if (context === null || binding === null) return null;
  if (context.state !== "granted" || context.live !== null) return null;
  const template = context.openUrlTemplate;
  const openUrl =
    !input.canOpenApp || template === null
      ? null
      : expandAppOpenUrl(template, {
          workspaceRoot: binding.workspaceRoot,
          threadId: input.threadId,
        });
  return {
    appId: context.appId,
    title: `${context.name} closed: live tools unavailable`,
    openLabel: `Open in ${context.name}`,
    openUrl,
  };
}

/**
 * The composer notice for an app thread whose app is not running. The app opens only from the
 * server's machine, and never from the embed, whose host is the app itself.
 */
export function useAppClosedBanner(
  projectRef: ScopedProjectRef | null,
  threadId: ThreadId | null,
): ComposerBannerStackItem | null {
  const binding = useProject(projectRef)?.appBinding ?? null;
  const context = useAppEmbedContext(binding === null ? null : projectRef);
  const embedPresentation = useEmbedPresentation();
  const remoteOpen = useRemoteOpenResolution(projectRef?.environmentId ?? null);
  const canOpenApp =
    embedPresentation === null &&
    !isLocalEnvironmentDisabled() &&
    remoteOpen.isResolved &&
    remoteOpen.state.mode === "local-exec";

  const banner = appClosedBanner({ context, binding, threadId, canOpenApp });
  if (banner === null) return null;
  const { openUrl } = banner;
  return {
    id: `app-closed:${banner.appId}`,
    variant: "warning",
    icon: createElement(UnplugIcon),
    title: banner.title,
    actions:
      openUrl === null
        ? undefined
        : createElement(
            Button,
            { size: "xs", variant: "ghost", onClick: () => openAppUrl(openUrl) },
            banner.openLabel,
            createElement(ExternalLinkIcon, { "aria-hidden": true }),
          ),
  };
}

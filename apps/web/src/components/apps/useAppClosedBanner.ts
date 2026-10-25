import type {
  AppBinding,
  AppEmbedContext,
  EnvironmentId,
  ScopedProjectRef,
  ThreadId,
} from "@lecturn/contracts";
import { expandAppOpenUrl } from "@lecturn/shared/appReferences";
import { ExternalLinkIcon, ShieldOffIcon, UnplugIcon } from "lucide-react";
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
  readonly kind: "closed" | "revoked";
  readonly title: string;
  readonly openLabel: string;
  readonly openUrl: string | null;
}

/**
 * Closed means granted with no live lease; the lease's expiry is not compared with the clock
 * because renewals are not broadcast and the server reports a lost lease itself. A revoked app has
 * no tools at all, and opening it is how it asks to pair again. A pending or denied app is still
 * the user's decision to make, in the pairing prompt or Settings, so it gets no notice here.
 */
export function appClosedBanner(input: {
  readonly context: AppEmbedContext | null;
  readonly binding: AppBinding | null;
  readonly threadId: ThreadId | null;
  readonly canOpenApp: boolean;
}): AppClosedBanner | null {
  const { context, binding } = input;
  if (context === null || binding === null) return null;
  const kind =
    context.state === "revoked"
      ? "revoked"
      : context.state === "granted" && context.live === null
        ? "closed"
        : null;
  if (kind === null) return null;
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
    kind,
    title:
      kind === "revoked"
        ? `${context.name} access revoked: open it to pair again`
        : `${context.name} closed: live tools unavailable`,
    openLabel: `Open in ${context.name}`,
    openUrl,
  };
}

/**
 * An app opens only from the server's machine, and never from the embed, whose host is the
 * app itself.
 */
export function useCanOpenApp(environmentId: EnvironmentId | null): boolean {
  const embedPresentation = useEmbedPresentation();
  const remoteOpen = useRemoteOpenResolution(environmentId);
  return (
    embedPresentation === null &&
    !isLocalEnvironmentDisabled() &&
    remoteOpen.isResolved &&
    remoteOpen.state.mode === "local-exec"
  );
}

/** The composer notice for an app thread whose app is not running or was revoked. */
export function useAppClosedBanner(
  projectRef: ScopedProjectRef | null,
  threadId: ThreadId | null,
): ComposerBannerStackItem | null {
  const binding = useProject(projectRef)?.appBinding ?? null;
  const context = useAppEmbedContext(binding === null ? null : projectRef);
  const canOpenApp = useCanOpenApp(projectRef?.environmentId ?? null);

  const banner = appClosedBanner({ context, binding, threadId, canOpenApp });
  if (banner === null) return null;
  const { openUrl } = banner;
  return {
    id: `app-${banner.kind}:${banner.appId}`,
    variant: "warning",
    icon: createElement(banner.kind === "revoked" ? ShieldOffIcon : UnplugIcon),
    title: banner.title,
    actions:
      openUrl === null
        ? undefined
        : createElement(
            Button,
            {
              size: "xs",
              variant: "ghost",
              onClick: () => openAppUrl(openUrl, context?.openUrlTemplate ?? null),
            },
            banner.openLabel,
            createElement(ExternalLinkIcon, { "aria-hidden": true }),
          ),
  };
}

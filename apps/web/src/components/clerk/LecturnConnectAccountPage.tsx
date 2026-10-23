import { useAuth, useClerk } from "@clerk/react";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { CONNECT_PROFILE_PAGES } from "./connectProfilePages";

type PortalTargets = Readonly<Record<string, HTMLDivElement | undefined>>;

/**
 * Clerk mounts custom pages into DOM nodes it owns, so the caller must keep `portals` rendered for
 * as long as the modal can be open.
 */
export function useLecturnConnectAccountPage(): {
  readonly open: (() => void) | null;
  readonly portals: ReactNode;
} {
  const clerk = useClerk();
  const { isSignedIn } = useAuth();
  const [targets, setTargets] = useState<PortalTargets>({});

  const open = () => {
    const setTarget = (key: string, element: HTMLDivElement | undefined) =>
      setTargets((current) => ({ ...current, [key]: element }));
    clerk.openUserProfile({
      __experimental_startPath: "/lecturn-connect",
      customPages: CONNECT_PROFILE_PAGES.map((page) => ({
        label: page.label,
        url: page.url,
        mount: (element: HTMLDivElement) => setTarget(`content:${page.url}`, element),
        unmount: () => setTarget(`content:${page.url}`, undefined),
        mountIcon: (element: HTMLDivElement) => setTarget(`icon:${page.url}`, element),
        unmountIcon: () => setTarget(`icon:${page.url}`, undefined),
      })),
    });
  };

  const portals = CONNECT_PROFILE_PAGES.flatMap(({ url, Icon, render }) => {
    const content = targets[`content:${url}`];
    const icon = targets[`icon:${url}`];
    return [
      content ? createPortal(render(), content, `content:${url}`) : null,
      icon ? createPortal(<Icon className="size-4" />, icon, `icon:${url}`) : null,
    ];
  });

  return { open: isSignedIn ? open : null, portals };
}

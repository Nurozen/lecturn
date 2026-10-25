import { APP_PAIRING_APPROVE_LABEL } from "../settings/ConnectedAppsSettings.logic";
import { Button } from "../ui/button";
import type { AppsSidebarPairing } from "./AppsSidebar.logic";
import { useConnectedAppCommands } from "./useConnectedAppCommands";

const PAIRING_DESCRIPTIONS = {
  new: "Wants to connect",
  changed: "Asks to run a different command",
  renew: "Asks for a new credential",
  repair: "Asks to pair again",
} as const satisfies Record<AppsSidebarPairing["kind"], string>;

/** A waiting pairing request, answerable in place; Settings > Connected apps has the details. */
export function AppPairingRow({ pairing }: { readonly pairing: AppsSidebarPairing }) {
  const commands = useConnectedAppCommands(pairing.environmentId);
  const disabled = !commands.canManage || commands.busyAppId === pairing.app.appId;
  const description = PAIRING_DESCRIPTIONS[pairing.kind];
  return (
    <li
      data-thread-selection-safe
      data-testid="app-pairing-row"
      className="lecturn-hierarchy-branch flex list-none flex-col gap-1.5 pt-2 pb-1"
    >
      <span className="flex min-h-7 items-center text-xs text-sidebar-foreground/80">
        {pairing.machineLabel ? `${description} on ${pairing.machineLabel}` : description}
      </span>
      <span className="flex items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => void commands.deny(pairing.app)}
        >
          Deny
        </Button>
        <Button size="xs" disabled={disabled} onClick={() => void commands.approve(pairing.app)}>
          {APP_PAIRING_APPROVE_LABEL[pairing.kind]}
        </Button>
      </span>
    </li>
  );
}

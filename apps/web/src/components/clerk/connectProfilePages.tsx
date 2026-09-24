import { CreditCardIcon, ServerIcon, SmartphoneIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { BillingAccount } from "../cloud/BillingAccount";
import { LecturnConnectUserProfilePage } from "./LecturnConnectUserProfilePage";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";

export interface ConnectProfilePage {
  readonly label: string;
  readonly url: string;
  readonly Icon: LucideIcon;
  readonly render: () => ReactNode;
}

/**
 * Lecturn's tabs inside Clerk's account profile. Clerk's `UserButton` and the
 * Connect account menu both mount these, so the two cannot drift apart.
 */
export const CONNECT_PROFILE_PAGES: ReadonlyArray<ConnectProfilePage> = [
  {
    label: "Billing",
    url: "billing",
    Icon: CreditCardIcon,
    render: () => <BillingAccount embedded />,
  },
  {
    label: "Mobile clients",
    url: "mobile-clients",
    Icon: SmartphoneIcon,
    render: () => <MobileClientsUserProfilePage />,
  },
  {
    label: "Lecturn Connect",
    url: "lecturn-connect",
    Icon: ServerIcon,
    render: () => <LecturnConnectUserProfilePage />,
  },
];

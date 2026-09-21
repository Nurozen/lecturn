import { createContext, useContext } from "react";
import type { MobileThemeVariables } from "./mobileTheme";
export const AccountTintContext = createContext<MobileThemeVariables>({});
export function useAccountTintVariables(): MobileThemeVariables {
  return useContext(AccountTintContext);
}

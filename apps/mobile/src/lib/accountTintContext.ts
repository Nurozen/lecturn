import { createContext, useContext } from "react";

/** Decorative ownership color is independent of semantic theme colors. */
export const AccountSurfaceColorContext = createContext<string | undefined>(undefined);
export function useAccountSurfaceColor() {
  return useContext(AccountSurfaceColorContext);
}

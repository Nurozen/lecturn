import { useSyncExternalStore } from "react";
import {
  getProfileSelectedAccountId,
  subscribeProfileSelectedAccountId,
} from "./withActiveAccount";
/** /me profile operations briefly switch Clerk sessions without selecting another Connect account. */
export function useProfileStableAccountId(
  clerkAccountId: string | null | undefined,
): string | null | undefined {
  const selected = useSyncExternalStore(
    subscribeProfileSelectedAccountId,
    getProfileSelectedAccountId,
    () => undefined,
  );
  return selected === undefined ? clerkAccountId : selected;
}

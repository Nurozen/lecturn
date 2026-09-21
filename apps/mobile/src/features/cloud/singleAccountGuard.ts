import {
  SINGLE_ACCOUNT_EXHAUSTED_MESSAGE,
  SINGLE_ACCOUNT_REJECTED_MESSAGE,
  makeSingleAccountEnforcer,
} from "@lecturn/client-runtime/relay";
import { Alert, AppState } from "react-native";

import { connectMultiAccount } from "./publicConfig";

export function makeMobileSingleAccountEnforcer() {
  return makeSingleAccountEnforcer({
    multiAccountEnabled: connectMultiAccount,
    // The shared-storage marker only exists on hosted web.
    readMarkerPresent: () => false,
    onRejected: () => {
      Alert.alert("Lecturn Connect", SINGLE_ACCOUNT_REJECTED_MESSAGE);
    },
    onStandDown: () => {},
    onExhausted: (signOutEverywhere) => {
      Alert.alert("Lecturn Connect", SINGLE_ACCOUNT_EXHAUSTED_MESSAGE, [
        { text: "Not now", style: "cancel" },
        {
          text: "Sign out of all accounts",
          style: "destructive",
          onPress: () => void signOutEverywhere(),
        },
      ]);
    },
    onError: (cause) => {
      console.error("Could not sign out the extra Connect account.", cause);
    },
    // Mobile publishes no host, so there is nothing to unpublish first.
    signOutEverywhere: (clerk) => clerk.signOut(),
    schedule: (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
    // Coming back to the foreground is also when a phone regains its network.
    subscribeWake: (wake) => {
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") wake();
      });
      return () => subscription.remove();
    },
  });
}

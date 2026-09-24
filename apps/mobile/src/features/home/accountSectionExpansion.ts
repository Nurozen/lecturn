import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { DEFAULT_GROUP_DISPLAY_STATE, type HomeGroupDisplayState } from "./homeListItems";

import { isAccountSectionKey, makeAccountSectionActions } from "./accountSectionExpansion.logic";
export { isAccountSectionKey } from "./accountSectionExpansion.logic";

const actions = makeAccountSectionActions({
  read: () => {
    const result = appAtomRegistry.get(mobilePreferencesAtom);
    return AsyncResult.isSuccess(result) ? (result.value.collapsedProjectGroups ?? []) : null;
  },
  subscribe: (ready) => appAtomRegistry.subscribe(mobilePreferencesAtom, ready),
  save: (collapsedProjectGroups) =>
    appAtomRegistry.set(updateMobilePreferencesAtom, {
      collapsedProjectGroups: [...collapsedProjectGroups],
    }),
});
/** Hydration-safe shared preference updates for phone, iPad and notification navigation. */
export const expandMobileAccountSection = actions.expand;
export const toggleMobileAccountSection = actions.toggle;
export const replaceCollapsedProjectGroups = actions.replaceProjects;
export const setMobileProjectGroupCollapsed = actions.setProject;

export function useAccountSectionDisplayStates(states: ReadonlyMap<string, HomeGroupDisplayState>) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return useMemo(() => {
    const next = new Map(states);
    for (const [key, state] of next)
      if (isAccountSectionKey(key)) next.set(key, { ...state, collapsed: false });
    if (AsyncResult.isSuccess(preferences))
      for (const key of preferences.value.collapsedProjectGroups ?? []) {
        if (isAccountSectionKey(key))
          next.set(key, { ...DEFAULT_GROUP_DISPLAY_STATE, collapsed: true });
      }
    return next;
  }, [states, preferences]);
}

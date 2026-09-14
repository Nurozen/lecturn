import { create } from "zustand";

const STORAGE_KEY = "lecturn:activity-interactions:v1";

export function retainActivityInteractions(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && Number.isFinite(Date.parse(entry[1])),
      )
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, 100),
  );
}
function readInteractions() {
  try {
    return retainActivityInteractions(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return {};
  }
}
export const useActivityRecentStore = create<{
  interactions: Record<string, string>;
  visit: (key: string, at: string) => void;
}>((set) => ({
  interactions: readInteractions(),
  visit: (key, at) =>
    set((state) => {
      const interactions = retainActivityInteractions({ ...state.interactions, [key]: at });
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(interactions));
      } catch {
        /* Remain usable without persistence. */
      }
      return { interactions };
    }),
}));

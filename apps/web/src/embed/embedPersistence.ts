import { isEmbedLocation } from "./embedAuth";

/** A `Storage` that lives and dies with the page. */
export function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(String(key)) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(String(key));
    },
    setItem: (key, value) => {
      values.set(String(key), String(value));
    },
  };
}

/**
 * The embed is served from the same origin as the user's own Lecturn tab, so anything it wrote to
 * localStorage (sidebar order, drafts, client settings) would land in that tab. Swapping in a
 * page-local store keeps every store that reads `localStorage` isolated without each one knowing
 * about the embed. It starts empty for the same reason: the user's drafts are not the app's.
 */
export function installEmbedMemoryStorage(target: object): boolean {
  try {
    Object.defineProperty(target, "localStorage", {
      configurable: true,
      enumerable: true,
      value: createMemoryStorage(),
    });
    return true;
  } catch {
    return false;
  }
}

// Stores read and capture `localStorage` while their modules load, so this runs on import, and
// main.tsx imports this module before anything else.
if (typeof window !== "undefined" && isEmbedLocation()) installEmbedMemoryStorage(window);

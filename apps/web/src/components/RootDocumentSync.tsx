import { useEffect } from "react";

import { syncBrowserChromeTheme } from "../hooks/useTheme";

/** Keyed by pathname: each route paints its own surface, which the browser chrome samples. */
export function BrowserChromeThemeSync() {
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncBrowserChromeTheme();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}

import { useEffect, useState } from "react";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";

export const DESKTOP_ACTIVITY_ENABLED_EVENT = "lecturn:activity-enabled";
export function DesktopActivityToggle() {
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const activity = typeof window === "undefined" ? undefined : window.desktopBridge?.activity;
  useEffect(() => {
    let mounted = true;
    void activity?.getEnabled().then((value) => {
      if (mounted) setEnabled(value);
    });
    const unsubscribe = activity?.onEnabledChange(setEnabled);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [activity]);
  if (!activity) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await activity.setEnabled(!enabled);
          setEnabled(!enabled);
          window.dispatchEvent(
            new CustomEvent(DESKTOP_ACTIVITY_ENABLED_EVENT, { detail: !enabled }),
          );
        } catch (cause) {
          toastManager.add({
            type: "error",
            title: "Could not change activity panel",
            description: cause instanceof Error ? cause.message : "Try again.",
          });
        } finally {
          setPending(false);
        }
      }}
    >
      {enabled ? "Hide activity notch" : "Show activity notch"}
    </Button>
  );
}

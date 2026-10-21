import { cn } from "~/lib/utils";

/**
 * Decorative companion to a visible loading label. "idle" dims it and stops the
 * orbit, for a spinner that stands in for a paused or retryable load.
 */
export function GoldThreadSpinner({
  className,
  variant = "default",
}: {
  className?: string;
  variant?: "default" | "idle";
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 48 48"
      fill="none"
      className={cn(
        "size-12 shrink-0",
        variant === "idle" && "opacity-35 grayscale [&_.lecturn-thread-orbit]:animate-none",
        className,
      )}
    >
      <circle cx="24" cy="24" r="19" stroke="var(--lecturn-spinner-gold)" strokeOpacity="0.2" />
      <ellipse
        cx="24"
        cy="24"
        rx="19"
        ry="11"
        transform="rotate(-35 24 24)"
        stroke="var(--lecturn-spinner-gold)"
        strokeOpacity="0.35"
        strokeWidth="0.75"
      />
      <g className="lecturn-thread-orbit">
        <path
          d="M24 5a19 19 0 0 1 19 19c0 10.5-8.5 19-19 19"
          stroke="var(--lecturn-spinner-gold)"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
        <path
          d="M43 24a19 19 0 0 1-5.56 13.44"
          stroke="var(--lecturn-spinner-highlight)"
          strokeWidth="1.5"
        />
        <circle cx="24" cy="43" r="3.5" fill="var(--lecturn-spinner-gold)" fillOpacity="0.15" />
        <circle cx="24" cy="43" r="1.5" fill="var(--lecturn-spinner-highlight)" />
      </g>
      <path
        d="m24 17 1.4 5.6L31 24l-5.6 1.4L24 31l-1.4-5.6L17 24l5.6-1.4Z"
        fill="var(--lecturn-spinner-gold)"
      />
      <circle cx="24" cy="24" r="1.25" fill="var(--lecturn-spinner-highlight)" />
    </svg>
  );
}

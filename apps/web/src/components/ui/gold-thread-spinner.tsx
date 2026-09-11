import { cn } from "~/lib/utils";

/** Decorative companion to a visible loading label. */
export function GoldThreadSpinner({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 48 48"
      fill="none"
      className={cn("size-12 shrink-0", className)}
    >
      <circle cx="24" cy="24" r="19" stroke="#dca64e" strokeOpacity="0.2" />
      <ellipse
        cx="24"
        cy="24"
        rx="19"
        ry="11"
        transform="rotate(-35 24 24)"
        stroke="#dca64e"
        strokeOpacity="0.35"
        strokeWidth="0.75"
      />
      <g className="lecturn-thread-orbit">
        <path
          d="M24 5a19 19 0 0 1 19 19c0 10.5-8.5 19-19 19"
          stroke="#dca64e"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
        <path d="M43 24a19 19 0 0 1-5.56 13.44" stroke="#ffe1a0" strokeWidth="1.5" />
        <circle cx="24" cy="43" r="3.5" fill="#dca64e" fillOpacity="0.15" />
        <circle cx="24" cy="43" r="1.5" fill="#ffe1a0" />
      </g>
      <path d="m24 17 1.4 5.6L31 24l-5.6 1.4L24 31l-1.4-5.6L17 24l5.6-1.4Z" fill="#dca64e" />
      <circle cx="24" cy="24" r="1.25" fill="#ffe1a0" />
    </svg>
  );
}

import type { SVGProps } from "react";

/** The Stave staff: a bound shaft and pointed, open crown around its crystal. */
export function StaveIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    >
      <path d="M3 21 12.5 11.5M5.5 18.5l1.5 1.5M8 16l1.5 1.5" />
      <path d="M12.5 12 9.5 8.5 12 3.5 12.5 7M12.5 12l4 1 4-4-3.5 1" />
      <path d="m14 5 6-3-3 6-3 1Z" fill="currentColor" strokeWidth=".8" />
    </svg>
  );
}

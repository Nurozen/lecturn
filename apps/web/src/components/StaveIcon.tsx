import type { SVGProps } from "react";

/** The Stave staff: a woven shaft and an open crown around its diamond. */
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
      <path d="m3 21 10.5-10.5M5 21 10 16M3 19l5-5M10.5 11.5l2 2" />
      <path d="m12.5 11.5-.8-3.3L16 3l5-1-1 5-5.2 4.3-2.3.2Z" />
      <path d="m15 8 1-3 3-1-1 3-3 1Z" fill="currentColor" strokeWidth=".8" />
      <path d="M21 10v3m-1.5-1.5h3" strokeWidth="1.2" />
    </svg>
  );
}

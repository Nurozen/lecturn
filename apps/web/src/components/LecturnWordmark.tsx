import type { SVGProps } from "react";
import lecturnMark from "../../../../assets/lecturn/mark.svg";

/** The shared Lecturn guild seal. */
export function LecturnWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
      <image href={lecturnMark} width="1024" height="1024" />
    </svg>
  );
}

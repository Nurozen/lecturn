import Svg, { Path } from "react-native-svg";

/** Small staff silhouette shared with the web Stave workspace marker. */
export function StaveIcon({ size = 20 }: { readonly size?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#e9bd72"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="m3 21 10.5-10.5M5 21 10 16M3 19l5-5M10.5 11.5l2 2" />
      <Path d="m12.5 11.5-.8-3.3L16 3l5-1-1 5-5.2 4.3-2.3.2Z" />
      <Path d="m15 8 1-3 3-1-1 3-3 1Z" fill="#e9bd72" strokeWidth={0.8} />
      <Path d="M21 10v3m-1.5-1.5h3" strokeWidth={1.2} />
    </Svg>
  );
}

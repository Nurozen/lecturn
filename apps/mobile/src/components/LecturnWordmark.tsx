import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * Lecturn illuminated book mark.
 */
export function LecturnWordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 1;
  return (
    <Svg
      accessibilityLabel="Lecturn"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 128 128"
    >
      <ThemedPath
        d="M29 44C42 40 53 43 64 50C75 43 86 40 99 44L97 68C85 66 75 69 64 75C53 69 43 66 31 68Z M64 50V75 M30 71C43 69 55 72 64 79C73 72 85 69 98 71 M57 81L60 94L48 103 M71 81L68 94L80 103 M64 80V102 M46 106C55 101 73 101 82 106 M64 12L67 21L76 24L67 27L64 36L61 27L52 24L61 21Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="none"
        stroke="currentColor"
        strokeWidth={4}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

import { View } from "react-native";
import { providerInstanceInitials } from "@lecturn/client-runtime/state/provider-instance-display";
import { CLAUDE_EMBLEM } from "@lecturn/shared/providerEmblems";
import { AppText as Text } from "./AppText";
import { Image } from "expo-image";
import { Path, Svg } from "react-native-svg";
import { useState } from "react";
import { resolveOfficialAcpRegistryIconUrl } from "@lecturn/contracts";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { getProviderClient } from "../lib/providerClients";

type ProviderIconProps = {
  readonly provider: string | null | undefined;
  readonly iconUrl?: string | null | undefined;
  readonly size?: number;
};

function AcpRegistryFallbackIcon(props: { readonly color: string; readonly size: number }) {
  return (
    <Svg width={props.size} height={props.size} viewBox="0 0 576 220" fill="none">
      <Path
        fill={props.color}
        d="M568.003 115.821 517.278 27.966C507.183 10.482 489.084.023 468.894.023c-20.167 0-38.22 10.413-48.338 27.852L343.251 161.75H242.755c-6.525 0-12.369-3.365-15.62-9.004-3.274-5.639-3.274-12.369 0-18.03l50.726-87.855c3.251-5.639 9.094-9.027 15.62-9.027 6.525 0 12.346 3.365 15.62 9.027l3.024 5.229a6.81 6.81 0 0 0 5.911 3.411c2.433 0 4.707-1.319 5.912-3.433l13.437-23.555c1.41-2.479 1.137-5.571-.682-7.753C325.699 7.57 309.874 0 293.322 0c-.66 0-1.319 0-2.001.045-19.281.705-36.561 11.141-46.247 27.898l-44.859 77.714-44.405-76.509C145.465 11.209 126.594.023 106.608.023c-.659 0-1.319 0-2.001.045-19.28.705-36.56 11.141-46.246 27.898L7.658 115.821c-13.915 24.078-8.526 52.999 13.392 71.938 8.844 7.663 20.554 11.869 32.968 11.869h94.63c2.433 0 4.684-1.296 5.912-3.411l13.96-24.191a6.81 6.81 0 0 0 0-6.821c-1.228-2.115-3.479-3.411-5.912-3.411H56.042c-6.526 0-12.369-3.365-15.62-9.004-3.275-5.638-3.275-12.368 0-18.03l50.725-87.854c3.252-5.639 9.095-9.027 15.62-9.027 6.526 0 12.346 3.365 15.62 9.027l72.439 125.62c.205.364.432.682.705 1 3.229 5.139 7.299 9.959 12.255 14.256 8.845 7.662 20.554 11.869 32.968 11.869h80.67l-5.843 10.118a6.81 6.81 0 0 0 0 6.821c1.228 2.114 3.478 3.41 5.911 3.41h27.944c2.432 0 4.683-1.296 5.911-3.41l9.049-15.689 2.774-4.433.114-.205 85.99-149.334c3.251-5.639 9.095-9.027 15.62-9.027 6.526 0 12.369 3.365 15.62 9.027l50.726 87.855c3.251 5.639 3.274 12.391 0 18.03-3.252 5.639-9.095 9.027-15.62 9.027H418.669c-2.433 0-4.684 1.296-5.912 3.41l-13.983 24.192a6.81 6.81 0 0 0 0 6.821c1.228 2.114 3.479 3.41 5.912 3.41H518.21c21.6 0 41.085-11.436 50.816-29.83 9.027-17.053 8.64-37.22-1.045-54Z"
      />
    </Svg>
  );
}

function AcpRegistryProviderIcon(props: {
  readonly color: string;
  readonly iconUrl: string | null | undefined;
  readonly size: number;
}) {
  const iconUrl = resolveOfficialAcpRegistryIconUrl(props.iconUrl);
  const [image, setImage] = useState<{
    readonly iconUrl: string;
    readonly status: "loaded" | "failed";
  } | null>(null);
  const currentImage = image?.iconUrl === iconUrl ? image : null;
  const loaded = currentImage?.status === "loaded";

  return (
    <View style={{ width: props.size, height: props.size }}>
      {!loaded ? <AcpRegistryFallbackIcon color={props.color} size={props.size} /> : null}
      {iconUrl !== null && currentImage?.status !== "failed" ? (
        <Image
          accessibilityIgnoresInvertColors
          cachePolicy="memory-disk"
          contentFit="contain"
          recyclingKey={iconUrl}
          source={{ uri: iconUrl }}
          style={{
            position: "absolute",
            width: props.size,
            height: props.size,
            opacity: loaded ? 1 : 0,
            tintColor: props.color,
          }}
          onError={() => setImage({ iconUrl, status: "failed" })}
          onLoad={() => setImage({ iconUrl, status: "loaded" })}
        />
      ) : null}
    </View>
  );
}

export function ProviderIcon(props: ProviderIconProps) {
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";
  const size = props.size ?? 16;
  const mono = isDarkMode ? "#e5e5e5" : "#171717";

  if (props.provider?.trim().toLowerCase() === "antigravity") {
    return (
      <Image
        source={require("../../assets/antigravity.png")}
        style={{ width: size, height: size }}
        contentFit="contain"
      />
    );
  }
  if (props.provider === "acpRegistry") {
    return <AcpRegistryProviderIcon color={mono} iconUrl={props.iconUrl} size={size} />;
  }

  if (props.provider === "claudeAgent") {
    return (
      <Svg width={size} height={size} viewBox={CLAUDE_EMBLEM.viewBox} fill={CLAUDE_EMBLEM.color}>
        {CLAUDE_EMBLEM.paths.map((d) => (
          <Path key={d} d={d} />
        ))}
      </Svg>
    );
  }

  if (props.provider === "githubCopilot") {
    return (
      <Svg width={size} height={size} viewBox="0 0 256 208" fill="none">
        <Path
          fill={mono}
          d="M205.3 31.4c14 14.8 20 35.2 22.5 63.6 6.6 0 12.8 1.5 17 7.2l7.8 10.6c2.2 3 3.4 6.6 3.4 10.4v28.7a12 12 0 0 1-4.8 9.5C215.9 187.2 172.3 208 128 208c-49 0-98.2-28.3-123.2-46.6a12 12 0 0 1-4.8-9.5v-28.7c0-3.8 1.2-7.4 3.4-10.5l7.8-10.5c4.2-5.7 10.4-7.2 17-7.2 2.5-28.4 8.4-48.8 22.5-63.6C77.3 3.2 112.6 0 127.6 0h.4c14.7 0 50.4 2.9 77.3 31.4ZM128 78.7c-3 0-6.5.2-10.3.6a27.1 27.1 0 0 1-6 12.1 45 45 0 0 1-32 13c-6.8 0-13.9-1.5-19.7-5.2-5.5 1.9-10.8 4.5-11.2 11-.5 12.2-.6 24.5-.6 36.8 0 6.1 0 12.3-.2 18.5 0 3.6 2.2 6.9 5.5 8.4C79.9 185.9 105 192 128 192s48-6 74.5-18.1a9.4 9.4 0 0 0 5.5-8.4c.3-18.4 0-37-.8-55.3-.4-6.6-5.7-9.1-11.2-11-5.8 3.7-13 5.1-19.7 5.1a45 45 0 0 1-32-12.9 27.1 27.1 0 0 1-6-12.1c-3.4-.4-6.9-.5-10.3-.6Zm-27 44c5.8 0 10.5 4.6 10.5 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.6-10.4 10.4-10.4Zm53.4 0c5.8 0 10.4 4.6 10.4 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.7-10.4 10.4-10.4Zm-73-94.4c-11.2 1.1-20.6 4.8-25.4 10-10.4 11.3-8.2 40.1-2.2 46.2A31.2 31.2 0 0 0 75 91.7c6.8 0 19.6-1.5 30.1-12.2 4.7-4.5 7.5-15.7 7.2-27-.3-9.1-2.9-16.7-6.7-19.9-4.2-3.6-13.6-5.2-24.2-4.3Zm69 4.3c-3.8 3.2-6.4 10.8-6.7 19.9-.3 11.3 2.5 22.5 7.2 27a41.7 41.7 0 0 0 30 12.2c8.9 0 17-2.9 21.3-7.2 6-6.1 8.2-34.9-2.2-46.3-4.8-5-14.2-8.8-25.4-9.9-10.6-1-20 .7-24.2 4.3ZM128 56c-2.6 0-5.6.2-9 .5.4 1.7.5 3.7.7 5.7 0 1.5 0 3-.2 4.5 3.2-.3 6-.3 8.5-.3 2.6 0 5.3 0 8.5.3-.2-1.6-.2-3-.2-4.5.2-2 .3-4 .7-5.7-3.4-.3-6.4-.5-9-.5Z"
        />
      </Svg>
    );
  }

  const packageIcon = getProviderClient(props.provider)?.icon;
  if (packageIcon) {
    const themeFill = (fill: { readonly light: string; readonly dark: string }) =>
      isDarkMode ? fill.dark : fill.light;
    return (
      <Svg width={size} height={size} viewBox={packageIcon.viewBox} fill="none">
        {packageIcon.paths.map((path) => (
          <Path
            key={path.d}
            d={path.d}
            fillRule={path.fillRule}
            fill={themeFill(path.fill ?? packageIcon.fill)}
          />
        ))}
      </Svg>
    );
  }

  // codex (and unknown drivers)
  return (
    <Svg width={size} height={size} viewBox="100 100 411 411" fill="none">
      <Path
        fill={mono}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M252.794 108.802C289.191 99.0484 326.265 110.305 351.148 135.135C385.113 126.072 422.85 134.862 449.492 161.505C476.136 188.149 484.925 225.888 475.862 259.85V259.854C500.696 284.735 511.95 321.81 502.198 358.207C492.447 394.602 464.161 421.084 430.215 430.217C421.083 464.162 394.603 492.448 358.206 502.199C321.812 511.951 284.734 500.693 259.852 475.864C225.887 484.927 188.15 476.137 161.507 449.495C134.864 422.851 126.073 385.111 135.136 351.149C110.304 326.266 99.0496 289.192 108.801 252.795C118.552 216.4 146.84 189.918 180.784 180.785C189.917 146.841 216.396 118.553 252.794 108.802ZM374.292 407.145C374.292 411.271 372.092 415.086 368.517 417.148L283.723 466.102C302.487 480.585 327.555 486.459 352.217 479.852C386.997 470.532 410.068 439.312 410.555 405.006V317.717C410.555 315.08 409.125 312.621 406.843 311.303L374.292 292.509V407.145ZM251.868 415.897C248.296 417.959 243.893 417.959 240.317 415.897L155.526 366.942C152.366 390.436 159.811 415.08 177.866 433.136H177.863C203.325 458.594 241.896 462.962 271.85 446.232L347.449 402.586C349.735 401.268 351.148 398.8 351.148 396.163V358.579L251.868 415.897ZM368.602 220.628C366.319 219.309 363.474 219.318 361.191 220.637L328.641 239.431L427.921 296.749C431.496 298.811 433.697 302.627 433.697 306.752V404.661C455.622 395.654 473.244 376.881 479.851 352.218C489.169 317.442 473.668 281.85 444.201 264.274L368.602 220.628ZM177.303 206.34C155.377 215.348 137.756 234.122 131.148 258.783C121.832 293.561 137.331 329.153 166.799 346.727L242.398 390.373C244.68 391.692 247.525 391.684 249.807 390.366L282.357 371.572L183.078 314.253C179.504 312.189 177.303 308.375 177.303 304.251V206.34ZM259.849 279.145V331.858L305.5 358.213L351.15 331.858V279.145L305.5 252.789L259.849 279.145ZM327.276 144.9C308.512 130.418 283.445 124.543 258.782 131.15C224.002 140.471 200.931 171.691 200.445 205.995V293.286C200.445 295.923 201.875 298.381 204.158 299.7L236.707 318.493V203.856C236.707 199.731 238.909 195.916 242.483 193.853L327.276 144.9ZM433.137 177.867C407.675 152.407 369.103 148.038 339.149 164.769L263.55 208.415C261.265 209.734 259.852 212.202 259.852 214.838V252.423L359.132 195.105C362.703 193.041 367.108 193.041 370.682 195.105L455.473 244.06C458.635 220.567 451.189 195.922 433.135 177.867H433.137Z"
      />
    </Svg>
  );
}

/**
 * `ProviderIcon` plus the web sidebar's account badge: an accent-color
 * initials bubble in the bottom-right corner, drawn when `showBadge` is set
 * (accent color present, or several instances share this driver). The glyph
 * dims to 60% opacity while the badge stays fully saturated, matching
 * `apps/web/src/components/chat/ProviderInstanceIcon.tsx`.
 */
export function ProviderInstanceIcon(props: {
  readonly iconUrl?: string | null;
  readonly provider: string | null | undefined;
  readonly size?: number;
  readonly displayName: string;
  readonly accentColor?: string;
  readonly showBadge?: boolean;
  readonly surfaceColor: string;
}) {
  return (
    <View style={{ position: "relative" }}>
      <View style={{ opacity: 0.6 }}>
        <ProviderIcon iconUrl={props.iconUrl} provider={props.provider} size={props.size} />
      </View>
      {props.showBadge ? (
        <View
          className={props.accentColor ? undefined : "bg-card"}
          style={{
            position: "absolute",
            right: -3,
            bottom: -3,
            height: 12,
            minWidth: 12,
            paddingHorizontal: 2,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: props.surfaceColor,
            backgroundColor: props.accentColor,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            className={props.accentColor ? undefined : "text-foreground-muted"}
            style={{
              fontSize: 7,
              fontWeight: "600",
              lineHeight: 9,
              color: props.accentColor ? "#ffffff" : undefined,
            }}
          >
            {providerInstanceInitials(props.displayName)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

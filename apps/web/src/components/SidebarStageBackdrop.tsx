import { useAtomValue } from "@effect/atom-react";
import { useId } from "react";

import nightlySkyUrl from "../assets/lecturn-night-sky.webp";
import { APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppStageLabel } from "../branding.logic";
import { primaryServerConfigAtom } from "../state/server";

export type SidebarStageBackdropVariant = "nightly" | "dev";
export type EnvironmentIdentificationPillLabel = "Dev" | "Nightly";

// A wide viewBox keeps the 96-unit art height at a fixed scale while sidebar resizing reveals
// more horizontal canvas instead of zooming the scene.
const STAGE_BACKDROP_VIEW_BOX = "0 0 8192 96";

export function resolveSidebarStageBackdropVariant(
  stageLabel: string,
  enabled = true,
): SidebarStageBackdropVariant | null {
  if (!enabled) return null;
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "nightly") return "nightly";
  if (normalized === "dev") return "dev";
  return null;
}

export function resolveSidebarStageFocusRingOffsetClass(
  variant: SidebarStageBackdropVariant,
): string {
  return variant === "nightly"
    ? "focus-visible:ring-offset-(--stage-night-bottom)"
    : "focus-visible:ring-offset-(--stage-art-bottom)";
}

export function resolveEnvironmentIdentificationPillLabel(
  stageLabel: string,
): EnvironmentIdentificationPillLabel | null {
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "dev") return "Dev";
  if (normalized === "nightly") return "Nightly";
  return null;
}

export function useEnvironmentStageLabel(): string {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveServerBackedAppStageLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

export function useSidebarStageBackdropVariant(enabled = true): SidebarStageBackdropVariant | null {
  return resolveSidebarStageBackdropVariant(useEnvironmentStageLabel(), enabled);
}

/** Static channel art shared by the sidebar header and composer. */
export function SidebarStageBackdrop({ variant }: { variant: SidebarStageBackdropVariant }) {
  return (
    <div
      aria-hidden
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden"
    >
      <StageBackdropArt variant={variant} />
    </div>
  );
}

export function StageBackdropArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return variant === "nightly" ? <NightlySkyArt /> : <DevBlueprintArt />;
}

export function StageBackdropButtonArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return variant === "nightly" ? <NightlySkyArt compact /> : <DevBlueprintArt compact />;
}

function NightlySkyArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const skyId = `${idPrefix}-stage-night-sky`;

  return (
    <svg
      aria-hidden
      className="stage-art stage-nightly h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "96 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {/* Fixed-scale artwork reveals more sky as the sidebar grows. The same
            quiet crop is used in the send button, with no filters or animation. */}
        <pattern id={skyId} width="384" height="96" patternUnits="userSpaceOnUse">
          <image
            href={nightlySkyUrl}
            width="384"
            height="96"
            preserveAspectRatio="xMidYMid slice"
          />
        </pattern>
      </defs>
      <rect width="100%" height="96" fill={`url(#${skyId})`} />
      <rect
        width="100%"
        height="96"
        style={{ fill: "var(--stage-night-bottom)" }}
        fillOpacity="0.12"
      />
    </svg>
  );
}

function DevBlueprintArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const paperId = `${idPrefix}-stage-bp-paper`;
  const glowId = `${idPrefix}-stage-bp-glow`;
  const celesteGlowId = `${idPrefix}-stage-bp-glow-celeste`;
  const violetGlowId = `${idPrefix}-stage-bp-glow-violet`;
  const minorGridId = `${idPrefix}-stage-bp-grid-minor`;
  const majorGridId = `${idPrefix}-stage-bp-grid-major`;
  const rulerId = `${idPrefix}-stage-bp-ruler`;
  const glowsId = `${idPrefix}-stage-bp-glows`;
  const annotationsId = `${idPrefix}-stage-bp-annotations`;

  return (
    <svg
      className="stage-art stage-blueprint h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "64 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={paperId}
          x1="60"
          y1="0"
          x2="220"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop style={{ stopColor: "var(--stage-art-bottom)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--stage-art-mid)" }} />
          <stop offset="1" style={{ stopColor: "var(--stage-art-top)" }} />
        </linearGradient>
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(216 14) rotate(137) scale(120 84)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-art-highlight)" }} stopOpacity="0.4" />
          <stop
            offset="0.52"
            style={{ stopColor: "var(--stage-art-secondary)" }}
            stopOpacity="0.16"
          />
          <stop offset="1" style={{ stopColor: "var(--stage-art-bottom)" }} stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={celesteGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(474 44) rotate(166) scale(156 92)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-art-celeste-highlight)" }} stopOpacity="0.34" />
          <stop
            offset="0.5"
            style={{ stopColor: "var(--stage-art-celeste-secondary)" }}
            stopOpacity="0.18"
          />
          <stop offset="1" style={{ stopColor: "var(--stage-art-bottom)" }} stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={violetGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(704 18) rotate(145) scale(132 88)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-art-violet-highlight)" }} stopOpacity="0.3" />
          <stop
            offset="0.52"
            style={{ stopColor: "var(--stage-art-tertiary)" }}
            stopOpacity="0.14"
          />
          <stop offset="1" style={{ stopColor: "var(--stage-art-bottom)" }} stopOpacity="0" />
        </radialGradient>
        <pattern id={minorGridId} width="8" height="8" patternUnits="userSpaceOnUse">
          <path
            d="M8 0H0V8"
            style={{ stroke: "var(--stage-art-grid-line)" }}
            strokeOpacity="0.14"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern id={majorGridId} width="32" height="32" patternUnits="userSpaceOnUse">
          <path
            d="M32 0H0V32"
            style={{ stroke: "var(--stage-art-grid-line)" }}
            strokeOpacity="0.26"
            strokeWidth="0.6"
          />
        </pattern>
        <pattern id={rulerId} width="32" height="6" patternUnits="userSpaceOnUse">
          <path
            d="M4 0V2.5M12 0V2.5M20 0V4M28 0V2.5"
            style={{ stroke: "var(--stage-art-line)" }}
            strokeOpacity="0.5"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern id={glowsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <rect width="768" height="96" fill={`url(#${glowId})`} />
          <rect width="768" height="96" fill={`url(#${celesteGlowId})`} />
          <rect width="768" height="96" fill={`url(#${violetGlowId})`} />
        </pattern>
        <pattern id={annotationsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <g
            style={{ stroke: "var(--stage-art-line)" }}
            strokeLinecap="round"
            strokeOpacity="0.6"
            strokeWidth="0.7"
          >
            <path d="M180 64H264" strokeDasharray="5 4" />
            <path d="M180 61V67M264 61V67" />
            <path d="M276 10V44" strokeDasharray="4 4" strokeOpacity="0.5" />
            <path d="M273 10H279M273 44H279" strokeOpacity="0.5" />
            <path d="M348 30H428" strokeDasharray="3.5 5" strokeOpacity="0.5" />
            <path d="M348 27V33M428 27V33" strokeOpacity="0.5" />
            <path d="M512 48V80" strokeDasharray="5 3" strokeOpacity="0.45" />
            <path d="M509 48H515M509 80H515" strokeOpacity="0.45" />
            <path d="M590 70H724" strokeDasharray="7 4" strokeOpacity="0.55" />
            <path d="M590 67V73M724 67V73" strokeOpacity="0.55" />
          </g>

          <g
            style={{ stroke: "var(--stage-art-line)" }}
            strokeLinecap="round"
            strokeOpacity="0.55"
            strokeWidth="0.6"
          >
            <g>
              <path d="M34 60L38 64M38 60L34 64" />
            </g>
            <g>
              <path d="M228 26H234M231 23V29" />
            </g>
            <g>
              <path d="M143 51H149M146 48V54" />
            </g>
            <g>
              <path d="M316 16L322 22M322 16L316 22" />
            </g>
            <g>
              <path d="M468 70H476M472 66V74" />
            </g>
            <g>
              <path d="M558 28L564 34M564 28L558 34" />
            </g>
            <g>
              <path d="M742 44H750M746 40V48" />
            </g>
          </g>

          <g style={{ stroke: "var(--stage-art-line)" }} strokeOpacity="0.35" strokeWidth="0.6">
            <circle cx="196" cy="38" r="13" strokeDasharray="3.5 4" />
            <path d="M196 33V43M191 38H201" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="414" cy="64" r="10" strokeDasharray="2.5 3.5" />
            <path d="M414 60V68M410 64H418" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="648" cy="32" r="15" strokeDasharray="4 5" />
            <path d="M648 26V38M642 32H654" strokeOpacity="0.6" strokeWidth="0.4" />
          </g>
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${paperId})`} />
      <rect width="100%" height="96" fill={`url(#${glowsId})`} />
      <rect width="100%" height="96" fill={`url(#${minorGridId})`} />
      <rect width="100%" height="96" fill={`url(#${majorGridId})`} />
      <rect width="100%" height="6" fill={`url(#${rulerId})`} />
      <rect width="100%" height="96" fill={`url(#${annotationsId})`} />
    </svg>
  );
}

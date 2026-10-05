import type { EnvironmentId } from "@lecturn/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useAccountTint } from "../cloud/useAccountTint";
import { knownConnectAccountsAtom } from "../cloud/knownAccounts";
import { cn } from "../lib/utils";
import {
  ACCOUNT_KNOCK_MS,
  ACCOUNT_TRANSITION_MS,
  accountWavePath,
  shouldAnimateAccountSelection,
} from "./accountTransition.logic";
import { knockCard } from "./cardKnock";
import { CelestialOrnaments } from "./CelestialOrnaments";
import "./account-surface.css";

type AccountSurfaceProps = ComponentProps<"div"> & {
  environmentId?: EnvironmentId | null;
  as?: "div" | "main";
  seam?: boolean;
  animate?: boolean;
  projectKey?: string | undefined;
};
type Reveal = {
  id: number;
  startedAt: number;
  originY: number;
  cardHeight: number;
  cardGap: number;
  cardTop: number;
  surfaceLeft: number;
  oldBackground: CSSProperties;
};

/** Decorations follow selection; navigation, focus and message rendering never wait on them. */
export function AccountSurface({
  environmentId,
  as: Tag = "div",
  seam = true,
  animate = false,
  projectKey,
  className,
  children,
  style,
  ...props
}: AccountSurfaceProps) {
  const tint = useAccountTint(environmentId);
  const accounts = useAtomValue(knownConnectAccountsAtom);
  const accountId = tint["data-account-id"];
  const multiAccount = accounts.accountIds.length > 1;
  const neutral = accounts.accountIds.length < 2 || !tint["data-account-id"];
  const hostRef = useRef<HTMLDivElement>(null);
  const accent = neutral
    ? "#d5af63"
    : ((tint.style as Record<string, string>)?.["--account-tint"] ?? "#d5af63");
  const selection = useRef({
    multiAccount: false,
    project: projectKey,
    account: accountId,
  });
  useLayoutEffect(() => {
    selection.current = {
      multiAccount,
      project: projectKey,
      account: accountId,
    };
  }, [multiAccount, projectKey, accountId]);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  useEffect(() => {
    if (!animate) return;
    let sequence = 0;
    let timeout: number | undefined;
    let clearKnock: (() => void) | undefined;
    const select = (event: MouseEvent | KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      if (event instanceof KeyboardEvent && (event.repeat || !["Enter", " "].includes(event.key)))
        return;
      if (event instanceof MouseEvent && (event.button !== 0 || event.detail > 1)) return;
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest<HTMLElement>("[data-lecturn-thread-surface]");
      const host = hostRef.current;
      if (!row || !host || row.dataset.threadActive === "true") return;
      // Nested menus/actions are not navigation, even though they sit inside the card.
      const action = target?.closest("button,a,input,[role=button]");
      if (action && action !== row) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const current = selection.current;
      if (
        !shouldAnimateAccountSelection(current.multiAccount, current, {
          project: row.dataset.threadProject,
          account: row.dataset.threadAccount,
        })
      )
        return;
      const cardRect = row.getBoundingClientRect();
      const surfaceRect = host.getBoundingClientRect();
      clearKnock?.();
      const knock = knockCard(row, surfaceRect.left);
      clearKnock = knock.cancel;
      window.clearTimeout(timeout);
      const painted = getComputedStyle(host);
      setReveal({
        id: ++sequence,
        startedAt: knock.startedAt,
        originY: cardRect.top + cardRect.height / 2 - surfaceRect.top,
        cardHeight: cardRect.height,
        cardGap: Math.max(0, surfaceRect.left - cardRect.right),
        cardTop: cardRect.top,
        surfaceLeft: surfaceRect.left,
        oldBackground: {
          backgroundColor: painted.backgroundColor,
          backgroundImage: painted.backgroundImage,
          backgroundSize: painted.backgroundSize,
          backgroundPosition: painted.backgroundPosition,
          backgroundRepeat: painted.backgroundRepeat,
        },
      });
      timeout = window.setTimeout(() => setReveal(null), ACCOUNT_TRANSITION_MS + 60);
    };
    document.addEventListener("click", select, true);
    document.addEventListener("keydown", select, true);
    return () => {
      document.removeEventListener("click", select, true);
      document.removeEventListener("keydown", select, true);
      window.clearTimeout(timeout);
      clearKnock?.();
    };
  }, [animate]);
  return (
    <Tag
      {...props}
      {...tint}
      ref={hostRef}
      data-glass-neutral={neutral || undefined}
      data-glass-seam={seam || undefined}
      data-account-transition={reveal ? "true" : undefined}
      className={cn("lecturn-account-surface", className)}
      style={{ ...tint.style, "--account-tint": accent, ...style } as CSSProperties}
    >
      {reveal ? <AccountWave key={reveal.id} reveal={reveal} accent={accent} /> : null}
      <CelestialOrnaments />
      {children}
    </Tag>
  );
}
function AccountWave({ reveal, accent }: { reveal: Reveal; accent: string }) {
  const shineId = useId();
  const impactRef = useRef<HTMLSpanElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const edgeRef = useRef<SVGPathElement>(null);
  const glowRef = useRef<SVGPathElement>(null);
  const ribbonRef = useRef<SVGPathElement>(null);
  const washRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const { width, height } = svg.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const start = reveal.startedAt;
    let frame = 0;
    const paint = (now: number) => {
      const elapsed = now - start;
      const impactProgress = (elapsed - ACCOUNT_KNOCK_MS) / 240;
      if (impactRef.current) {
        impactRef.current.style.opacity = String(
          impactProgress >= 0 && impactProgress <= 1 ? 1 - impactProgress : 0,
        );
        impactRef.current.style.transform = `scale(${0.8 + Math.max(0, impactProgress) * 0.7})`;
      }
      const { edge, wash, progress } = accountWavePath(width, height, reveal.originY, elapsed);
      edgeRef.current?.setAttribute("d", edge);
      glowRef.current?.setAttribute("d", edge);
      ribbonRef.current?.setAttribute("d", edge);
      svg.parentElement?.style.setProperty("--account-wave-progress", String(progress));
      if (washRef.current) washRef.current.style.clipPath = `path("${wash}")`;
      svg.style.opacity = String(progress > 0.9 ? (1 - progress) * 10 : 1);
      if (elapsed < ACCOUNT_TRANSITION_MS && !document.hidden) frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [reveal]);
  return (
    <>
      {createPortal(
        <span
          aria-hidden="true"
          ref={impactRef}
          className="lecturn-account-impact"
          style={
            {
              "--glass-accent": accent,
              "--glass-light": `color-mix(in srgb, ${accent} 64%, white)`,
              top: reveal.cardTop + reveal.cardHeight / 2 - 6,
              height: 12,
              left: reveal.surfaceLeft - reveal.cardGap - 4,
              width: reveal.cardGap + 5,
            } as CSSProperties
          }
        />,
        document.body,
      )}
      <div
        ref={washRef}
        aria-hidden="true"
        className="lecturn-account-old-pane"
        style={reveal.oldBackground}
      />
      <svg ref={svgRef} className="lecturn-account-wave" aria-hidden="true">
        <defs>
          <linearGradient id={shineId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--glass-accent)" />
            <stop offset="36%" stopColor="var(--glass-light)" />
            <stop offset="55%" stopColor="#f2fffc" />
            <stop offset="74%" stopColor="var(--glass-light)" />
            <stop offset="100%" stopColor="var(--glass-accent)" />
          </linearGradient>
        </defs>
        <path ref={ribbonRef} className="lecturn-account-wave-ribbon" />
        <path ref={glowRef} className="lecturn-account-wave-glow" />
        <path
          ref={edgeRef}
          className="lecturn-account-wave-edge"
          style={{ stroke: `url(#${shineId})` }}
        />
      </svg>
    </>
  );
}

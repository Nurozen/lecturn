import type { ReactNode } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { useClientSettings } from "../../hooks/useSettings";
import { LecturnWordmark } from "../LecturnWordmark";

const backdropClassNames = {
  pairing:
    "absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-emerald-500)_14%,transparent),transparent)]",
  error:
    "absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]",
  brand:
    "absolute inset-x-0 top-0 h-72 bg-[radial-gradient(48rem_20rem_at_top,color-mix(in_srgb,var(--color-blue-500)_12%,transparent),transparent)]",
};

export function StandalonePage({
  tone = "brand",
  masthead,
  compact = false,
  children,
}: {
  /** Lecturn look only: the backdrop tint. The new design has one plain dialog surface. */
  readonly tone?: keyof typeof backdropClassNames;
  /** Lecturn look only: artwork above the card body. */
  readonly masthead?: ReactNode;
  /** Narrower card with tighter padding, for short confirmation pages. */
  readonly compact?: boolean;
  readonly children: ReactNode;
}) {
  const redesign = useClientSettings((s) => s.redesignEnabled);
  if (redesign) {
    return (
      // The page owns scrolling because root cannot scroll; safe centering keeps oversized cards top-aligned.
      <div className="flex h-full items-center-safe justify-center overflow-y-auto scrollbar-gutter-both bg-background px-4 py-10 text-foreground sm:px-6">
        <section
          className={`dialog-glass w-full ${compact ? "max-w-md" : "max-w-xl"} rounded-2xl border p-6`}
        >
          {children}
        </section>
      </div>
    );
  }
  return (
    <div className="relative h-full overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 opacity-80" aria-hidden>
        <div className={backdropClassNames[tone]} />
        {tone === "pairing" ? (
          <div className="absolute inset-y-0 left-0 w-72 bg-[radial-gradient(28rem_18rem_at_left,color-mix(in_srgb,var(--color-sky-500)_10%,transparent),transparent)]" />
        ) : null}
        <div
          className={
            tone === "brand"
              ? "absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_94%,var(--color-black))_0%,var(--background)_62%)]"
              : "absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]"
          }
        />
      </div>

      <div className="relative flex h-full items-center-safe justify-center overflow-y-auto scrollbar-gutter-both px-4 py-10 sm:px-6">
        <section
          className={`relative w-full ${compact ? "max-w-md" : "max-w-xl"} rounded-2xl border border-border/80 shadow-2xl shadow-black/20 backdrop-blur-md ${tone === "brand" ? "overflow-hidden bg-card/94" : "bg-card/90"}`}
        >
          {masthead}
          <div className={compact ? "p-5 sm:p-6" : "p-6 sm:p-8"}>{children}</div>
        </section>
      </div>
    </div>
  );
}

export function StandalonePageHeader({
  context,
  title,
  description,
}: {
  readonly context?: ReactNode;
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  const redesign = useClientSettings((s) => s.redesignEnabled);
  if (redesign) {
    return (
      <>
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <LecturnWordmark className="size-5 shrink-0" aria-hidden />
            <span className="text-lg font-medium tracking-tight text-foreground">
              {APP_DISPLAY_NAME}
            </span>
          </span>
          {context ? <span className="text-sm">{context}</span> : null}
        </div>
        <h1 className="mt-6 text-xl leading-tight font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </>
    );
  }
  // Lecturn look: a page names the app; an auth step names itself in the primary color.
  return (
    <>
      {context ? (
        <p className="text-3xs font-semibold tracking-widest text-primary uppercase">{context}</p>
      ) : (
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
      )}
      <h1
        className={`${context ? "mt-2" : "mt-3"} text-2xl font-semibold tracking-tight sm:text-3xl`}
      >
        {title}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

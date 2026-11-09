import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

// The Lecturn look is the bordered pill. Beta "New design" (data-redesign) gets the inline
// chip without a pill through the redesign: classes, colored from the theme's chip palette.
const contextChipVariants = cva(
  "inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] border px-[0.5em] align-middle font-medium [:root:not([data-redesign])_&]:text-[0.86em] leading-none [&_svg]:block [&_svg]:size-[1.17em] [&_svg]:shrink-0 [&_svg]:self-center [button&,a&,[data-popup-open]&]:cursor-pointer [button&,a&]:transition-colors [button&,a&]:motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground disabled:cursor-default redesign:h-auto redesign:gap-[0.2em] redesign:rounded-sm redesign:border-0 redesign:bg-transparent! redesign:px-0 redesign:align-baseline redesign:leading-[normal] redesign:text-(--context-chip-ink) redesign:[--context-chip-ink:var(--context-chip-accent)] redesign:[--document-icon-stroke:var(--context-chip-ink)] redesign:[&_svg]:size-[1em] redesign:focus-visible:outline-current",
  {
    defaultVariants: { kind: "neutral" },
    variants: {
      kind: {
        neutral:
          "border-border/70 bg-accent/40 text-foreground redesign:[--context-chip-accent:currentColor]",
        image:
          "[--context-chip-accent:oklch(0.62_0.16_16)] redesign:[--context-chip-accent:var(--context-chip-image)]",
        video:
          "[--context-chip-accent:oklch(0.62_0.16_48)] redesign:[--context-chip-accent:var(--context-chip-video)]",
        file: "[--context-chip-accent:oklch(0.62_0.136_237)] redesign:[--context-chip-accent:var(--context-chip-file)]",
        mention:
          "[--context-chip-accent:oklch(0.62_0.11_215)] redesign:[--context-chip-accent:var(--context-chip-mention)]",
        terminal:
          "[--context-chip-accent:oklch(0.62_0.134_163)] redesign:[--context-chip-accent:var(--context-chip-terminal)]",
        element:
          "[--context-chip-accent:oklch(0.62_0.134_70)] redesign:[--context-chip-accent:var(--context-chip-element)]",
        "preview-annotation":
          "[--context-chip-accent:oklch(0.62_0.134_70)] redesign:[--context-chip-accent:var(--context-chip-preview-annotation)]",
        "review-comment":
          "[--context-chip-accent:oklch(0.62_0.16_292)] redesign:[--context-chip-accent:var(--context-chip-review-comment)]",
        "pull-request":
          "[--context-chip-accent:oklch(0.62_0.16_277)] redesign:[--context-chip-accent:var(--context-chip-pull-request)]",
        "pr-open":
          "[--context-chip-accent:oklch(0.62_0.134_163)] redesign:[--context-chip-accent:var(--context-chip-pr-open)]",
        "pr-draft":
          "[--context-chip-accent:oklch(0.62_0.02_259)] redesign:[--context-chip-accent:var(--context-chip-pr-draft)]",
        "pr-merged":
          "[--context-chip-accent:oklch(0.62_0.16_292)] redesign:[--context-chip-accent:var(--context-chip-pr-merged)]",
        "pr-closed":
          "[--context-chip-accent:oklch(0.62_0.16_16)] redesign:[--context-chip-accent:var(--context-chip-pr-closed)]",
        skill:
          "[--context-chip-accent:oklch(0.62_0.16_322)] redesign:[--context-chip-accent:var(--context-chip-skill)]",
        thread:
          "[--context-chip-accent:oklch(0.62_0.12_190)] redesign:[--context-chip-accent:var(--context-chip-thread)]",
        environment:
          "[--context-chip-accent:oklch(0.62_0.11_145)] redesign:[--context-chip-accent:var(--context-chip-environment)]",
        citation:
          "[--context-chip-accent:oklch(0.62_0.16_259)] redesign:[--context-chip-accent:var(--context-chip-citation)]",
        "doc-pdf":
          "[--context-chip-accent:light-dark(#d52c36,#ff6762)] redesign:[--context-chip-accent:var(--context-chip-doc-pdf)]",
        "doc-word":
          "[--context-chip-accent:light-dark(#1a85d4,#69b1ff)] redesign:[--context-chip-accent:var(--context-chip-doc-word)]",
        "doc-spreadsheet":
          "[--context-chip-accent:light-dark(#199f43,#5ecc71)] redesign:[--context-chip-accent:var(--context-chip-doc-spreadsheet)]",
        "doc-slides":
          "[--context-chip-accent:light-dark(#d47628,#ffa359)] redesign:[--context-chip-accent:var(--context-chip-doc-slides)]",
        "doc-epub":
          "[--context-chip-accent:light-dark(#693acf,#9d6afb)] redesign:[--context-chip-accent:var(--context-chip-doc-epub)]",
        // The app's own accent: the host's primary inside an embed.
        "app-ref": "[--context-chip-accent:var(--primary)]",
      },
      shape: {
        inline: "",
        bubble: "w-64 gap-2 rounded-2xl bg-message px-3 py-2 text-sm text-message-foreground",
      },
      state: {
        unresolved:
          "border-dashed redesign:data-[state=unresolved]:[--context-chip-accent:currentColor]",
        invalid:
          "redesign:data-[state=invalid]:[--context-chip-accent:var(--context-chip-invalid,var(--destructive-foreground))]",
      },
    },
    compoundVariants: [
      {
        kind: [
          "image",
          "video",
          "file",
          "mention",
          "terminal",
          "element",
          "preview-annotation",
          "review-comment",
          "pull-request",
          "pr-open",
          "pr-draft",
          "pr-merged",
          "pr-closed",
          "skill",
          "thread",
          "citation",
          "doc-pdf",
          "doc-word",
          "doc-spreadsheet",
          "doc-slides",
          "doc-epub",
          "app-ref",
        ],
        className:
          "[--context-chip-border:color-mix(in_oklab,var(--context-chip-accent)_34%,var(--contrast-border))] [--context-chip-border-hover:color-mix(in_oklab,var(--context-chip-accent)_48%,var(--contrast-border))] [--context-chip-foreground:color-mix(in_oklab,var(--context-chip-accent)_22%,var(--contrast-foreground))] border-(--context-chip-border) bg-(--context-chip-accent)/11 text-(--context-chip-foreground) [button:enabled&,a&]:hover:border-(--context-chip-border-hover) [button:enabled&,a&]:hover:bg-(--context-chip-accent)/17",
      },
      { state: "unresolved", className: "text-foreground" },
      { state: "invalid", className: "border-destructive/35 bg-destructive/8 text-destructive" },
    ],
  },
);

type ContextChipKind = NonNullable<VariantProps<typeof contextChipVariants>["kind"]>;

/** The chip look for text the editor decorates in place, where no element can be rendered. */
function contextChipClassName(kind: ContextChipKind): string {
  return contextChipVariants({ kind });
}

interface ContextChipProps extends useRender.ComponentProps<"span"> {
  kind?: ContextChipKind;
  state?: "unresolved" | "invalid";
  shape?: "inline" | "bubble";
}

function ContextChip({ className, kind, state, shape, render, ...props }: ContextChipProps) {
  const defaultProps = {
    className: cn(contextChipVariants({ kind, state, shape }), className),
    "data-slot": "context-chip",
    "data-state": state,
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

function ContextChipLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        // The Lecturn pill centers a tight label; the new design sets it on the sentence baseline
        // and underlines it on hover.
        "block min-w-0 text-ellipsis whitespace-nowrap [:root:not([data-redesign])_&]:self-center [:root:not([data-redesign])_&]:overflow-hidden [:root:not([data-redesign])_&]:leading-tight redesign:self-baseline redesign:overflow-x-clip redesign:underline redesign:decoration-transparent redesign:decoration-1 redesign:underline-offset-[0.2em] redesign:transition-colors redesign:motion-reduce:transition-none redesign:[:is(button:enabled,a):hover>&]:decoration-current",
        className,
      )}
      data-slot="context-chip-label"
      {...props}
    />
  );
}

function ContextChipAction({ className, render, ...props }: useRender.ComponentProps<"button">) {
  const defaultProps = {
    className: cn(
      "ml-[0.17em] inline-flex size-[1.17em] shrink-0 cursor-pointer items-center justify-center rounded-sm text-current transition-colors hover:bg-(--context-chip-accent,var(--color-foreground))/17 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none redesign:size-[1em] [&_svg]:size-[0.85em]",
      className,
    ),
    "data-slot": "context-chip-action",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export {
  ContextChip,
  ContextChipAction,
  ContextChipLabel,
  contextChipClassName,
  type ContextChipKind,
};

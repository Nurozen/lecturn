"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "~/lib/utils";

const labelVariantClassName = {
  default: "",
  /** A choice's caption beside its control (switch, radio); regular weight. */
  option: "font-normal",
  /** A checkbox and its caption, set closer together than a field label. */
  checkbox: "gap-1.5 font-normal",
} as const;

const labelSizeClassName = {
  default: "",
  sm: "text-xs",
} as const;

const labelToneClassName = {
  default: "",
  muted: "text-muted-foreground",
} as const;

function Label({
  className,
  render,
  variant = "default",
  size = "default",
  tone = "default",
  ...props
}: useRender.ComponentProps<"label"> & {
  variant?: keyof typeof labelVariantClassName;
  size?: keyof typeof labelSizeClassName;
  tone?: keyof typeof labelToneClassName;
}) {
  const defaultProps = {
    className: cn(
      "inline-flex items-center gap-2 text-base/4.5 sm:text-sm/4 font-medium text-foreground",
      labelVariantClassName[variant],
      labelSizeClassName[size],
      labelToneClassName[tone],
      className,
    ),
    "data-slot": "label",
  };

  return useRender({
    defaultTagName: "label",
    props: mergeProps<"label">(defaultProps, props),
    render,
  });
}

export { Label };

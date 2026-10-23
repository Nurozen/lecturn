"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

import { cn } from "~/lib/utils";

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ className, ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      className={cn("cursor-pointer", className)}
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

/**
 * "hierarchy" is the Lecturn sidebar fold (slower travel and a glass rim while moving, in
 * index.css); "account-hierarchy" adds the account rail it carries (components/sidebar/account-glass.css).
 */
const collapsiblePanelVariantClassName = {
  default: "",
  hierarchy: "lecturn-hierarchy-panel",
  "account-hierarchy": "lecturn-account-collapse lecturn-hierarchy-panel",
} as const;

function CollapsiblePanel({
  className,
  animate = true,
  variant = "default",
  ...props
}: CollapsiblePrimitive.Panel.Props & {
  animate?: boolean;
  variant?: keyof typeof collapsiblePanelVariantClassName;
}) {
  return (
    <CollapsiblePrimitive.Panel
      className={cn(
        "overflow-hidden",
        animate &&
          "h-(--collapsible-panel-height) transition-[height] duration-200 motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0 data-open:data-ending-style:[height:var(--collapsible-panel-height)]",
        collapsiblePanelVariantClassName[variant],
        className,
      )}
      data-slot="collapsible-panel"
      {...props}
    />
  );
}

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
  CollapsiblePanel as CollapsibleContent,
};

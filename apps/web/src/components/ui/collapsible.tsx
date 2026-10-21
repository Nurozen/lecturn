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
  variant = "default",
  ...props
}: CollapsiblePrimitive.Panel.Props & {
  variant?: keyof typeof collapsiblePanelVariantClassName;
}) {
  // Reuses the local shadcn/Base UI panel; skip height travel for reduced motion.
  // https://ui.shadcn.com/docs/components/base/collapsible
  return (
    <CollapsiblePrimitive.Panel
      className={cn(
        "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0 data-open:data-ending-style:[height:var(--collapsible-panel-height)]",
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

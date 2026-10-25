import { LayoutGridIcon } from "lucide-react";

/** An app's registered icon; an app whose status this client cannot read gets a placeholder. */
export function AppIcon({ iconDataUrl }: { readonly iconDataUrl: string | null }) {
  return iconDataUrl === null ? (
    <LayoutGridIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
  ) : (
    <img
      src={iconDataUrl}
      alt=""
      aria-hidden
      draggable={false}
      className="size-4 shrink-0 rounded-sm object-cover"
    />
  );
}

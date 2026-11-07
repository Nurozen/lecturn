import { cn } from "~/lib/utils";

/**
 * Collapsed view of a failed provider update's captured command output. Pass
 * the tail from `tailProviderUpdateOutput`, not the full capture.
 */
export function ProviderUpdateOutput({
  output,
  className,
}: {
  readonly output: string;
  readonly className?: string;
}) {
  return (
    <details className={cn("min-w-0 text-xs text-muted-foreground", className)}>
      <summary className="cursor-pointer select-none hover:text-foreground">Show output</summary>
      <ProviderUpdateOutputText output={output} className="mt-1" />
    </details>
  );
}

/** The captured output itself, for hosts that bring their own disclosure. */
export function ProviderUpdateOutputText({
  output,
  className,
}: {
  readonly output: string;
  readonly className?: string;
}) {
  return (
    <pre
      className={cn(
        "max-h-40 overflow-auto rounded-md border border-border/70 bg-muted/40 p-2 font-mono text-2xs leading-snug break-words whitespace-pre-wrap text-foreground",
        className,
      )}
    >
      {output}
    </pre>
  );
}

import { useNavigate } from "@tanstack/react-router";

import { useEmbedPresentation, type EmbedPresentation } from "./EmbedPresentationContext";

type Navigate = ReturnType<typeof useNavigate>;

export type EmbedNavigationTarget =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "project" };

/**
 * Where a navigation meant for the full app lands inside the embed. Threads stay threads, and the
 * app's home and project pages become the embedded project. Everything else (drafts, settings)
 * has no embed route, so it goes nowhere rather than leaving the embed.
 */
export function embedNavigationTarget(options: {
  readonly to?: unknown;
  readonly params?: unknown;
}): EmbedNavigationTarget | null {
  if (options.to === "/" || options.to === "/projects/$projectKey") return { kind: "project" };
  if (options.to !== "/$environmentId/$threadId") return null;
  const threadId: unknown =
    typeof options.params === "object" && options.params !== null
      ? Reflect.get(options.params, "threadId")
      : undefined;
  return typeof threadId === "string" && threadId !== "" ? { kind: "thread", threadId } : null;
}

function navigateInEmbed(
  navigate: Navigate,
  presentation: EmbedPresentation,
  options: { readonly to?: unknown; readonly params?: unknown; readonly replace?: boolean },
) {
  const target = embedNavigationTarget(options);
  if (target === null) return Promise.resolve();
  const { environmentId, projectId } = presentation.projectRef;
  const replace = options.replace === true;
  return target.kind === "project"
    ? navigate({
        to: "/embed/$environmentId/$projectId",
        params: { environmentId, projectId },
        replace,
      })
    : navigate({
        to: "/embed/$environmentId/$projectId/$threadId",
        params: { environmentId, projectId, threadId: target.threadId },
        replace,
      });
}

/** `useNavigate`, except that under /embed it keeps the view inside the embedded project. */
export function useEmbedAwareNavigate(): Navigate {
  const navigate = useNavigate();
  const presentation = useEmbedPresentation();
  if (presentation === null) return navigate;
  return ((options: Parameters<typeof navigateInEmbed>[2]) =>
    navigateInEmbed(navigate, presentation, options)) as Navigate;
}

import { createFileRoute } from "@tanstack/react-router";

// The view lives in the parent embed route, so switching threads keeps one ChatView mounted, as
// in the _chat layout.
export const Route = createFileRoute("/embed/$environmentId/$projectId/$threadId")({
  component: () => null,
});

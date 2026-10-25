import { createFileRoute } from "@tanstack/react-router";

// The parent embed route swaps its chat for the providers panel, so the bridge it holds keeps
// answering the host while the panel is open.
export const Route = createFileRoute("/embed/$environmentId/$projectId/providers")({
  component: () => null,
});

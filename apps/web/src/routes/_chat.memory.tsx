import { createFileRoute } from "@tanstack/react-router";
import { MemoryPage, type MemorySearch } from "../components/memory/MemoryPage";

const nonEmpty = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function parseMemorySearch(raw: Record<string, unknown>): MemorySearch {
  const environmentId = nonEmpty(raw.environmentId);
  const projectId = nonEmpty(raw.projectId);
  const lit = nonEmpty(raw.lit);
  return {
    ...(environmentId ? { environmentId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(raw.gate === "1" || raw.gate === 1 ? { gate: "1" as const } : {}),
    ...(lit ? { lit } : {}),
  };
}

export const Route = createFileRoute("/_chat/memory")({
  validateSearch: parseMemorySearch,
  component: function MemoryRoute() {
    return <MemoryPage search={Route.useSearch()} />;
  },
});

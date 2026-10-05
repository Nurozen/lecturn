import { createFileRoute } from "@tanstack/react-router";
import { RelaySettings } from "../components/settings/RelaySettings";

export const Route = createFileRoute("/settings/relay")({ component: RelaySettings });

import type { APIRoute } from "astro";

import { buildLecturnProjectFileJsonSchema } from "@lecturn/shared/lecturnProjectFile";

// Rendered at build time; published at https://lecturn.cloudgatherer.net/schema/lecturn.json so
// lecturn.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildLecturnProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });

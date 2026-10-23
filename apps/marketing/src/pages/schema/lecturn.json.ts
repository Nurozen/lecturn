import type { APIRoute } from "astro";

import { buildLecturnProjectFileJsonSchema } from "@lecturn/shared/lecturnProjectFile";

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildLecturnProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });

import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://lecturn.cloudgatherer.net",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});

import { matchers, routes, type VercelConfig } from "@vercel/config/v1";

const LATEST_ORIGIN = "https://lecturn.cloudgatherer.net";
const NIGHTLY_ORIGIN = "https://nightly.lecturn.cloudgatherer.net";

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @lecturn/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@lecturn/scripts...' --filter '@lecturn/web...'",
  routes: [
    // Keep the existing client endpoint compatible. Channels redirect to their
    // own deployments; the primary host serves its local static files directly.
    {
      src: "/__lecturn/channel",
      has: [matchers.query("channel", "nightly")],
      headers: { Location: `${NIGHTLY_ORIGIN}/` },
      status: 302,
    },
    {
      src: "/__lecturn/channel",
      headers: { Location: `${LATEST_ORIGIN}/` },
      status: 302,
    },
  ],
  rewrites: [
    routes.rewrite("/privacy-policy", "/privacy-policy/index.html"),
    routes.rewrite("/privacy-policy/", "/privacy-policy/index.html"),
    routes.rewrite("/terms-of-service", "/terms-of-service/index.html"),
    routes.rewrite("/terms-of-service/", "/terms-of-service/index.html"),
    routes.rewrite("/security-policy", "/security-policy/index.html"),
    routes.rewrite("/security-policy/", "/security-policy/index.html"),
    routes.rewrite("/(.*)", "/index.html"),
  ],
};

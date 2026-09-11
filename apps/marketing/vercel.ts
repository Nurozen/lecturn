import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    deploymentEnabled: false,
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@lecturn/marketing...'",
  buildCommand: "vp run --filter @lecturn/marketing build",
  outputDirectory: "dist",
};

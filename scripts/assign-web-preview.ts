// @effect-diagnostics nodeBuiltinImport:off - GitHub Actions entrypoint writes its own output file.
import * as NodeFS from "node:fs";

import { assignWebPreview } from "./lib/web-preview.ts";

const previewUrl = await assignWebPreview(process.env);
if (process.env.GITHUB_OUTPUT) {
  NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `preview_url=${previewUrl}\n`);
}
process.stdout.write(`Preview ready: ${previewUrl}\n`);

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Host-side tooling with no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { embedHostDir, resolveEmbedHostLaunch } from "./electronLauncher.ts";

if (!NodeFS.existsSync(NodePath.join(embedHostDir, "dist", "main.mjs"))) {
  console.error("embed-host is not built; run `vp run --filter embed-host build` first.");
  process.exit(1);
}

const command = await resolveEmbedHostLaunch(process.argv.slice(2));
const child = NodeChildProcess.spawn(command.electronPath, command.args, {
  stdio: "inherit",
  env: process.env,
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1));
});

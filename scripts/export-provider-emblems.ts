// @effect-diagnostics nodeBuiltinImport:off - Standalone asset export.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CLAUDE_EMBLEM } from "../packages/shared/src/providerEmblems.ts";
const root = new URL("../", import.meta.url);
const target = new URL("assets/provider-emblems/", root);
mkdirSync(target, { recursive: true });
const emblem = CLAUDE_EMBLEM;
const paths = emblem.paths.map((d) => `<path d="${d}"/>`).join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="${emblem.viewBox}" fill="${emblem.color}">${paths}</svg>\n`;
writeFileSync(new URL("claudeAgent.svg", target), svg);
writeFileSync(new URL("apps/marketing/public/harnesses/claude-ai-icon.svg", root), svg);
// Keep a literal sprite so the native file-icon generator can extract it without executing web code.
const spriteFile = new URL("apps/web/src/pierre-icons.ts", root);
const sprite = readFileSync(spriteFile, "utf8");
const symbol = `<symbol id="lecturn-file-icon-claude" viewBox="${emblem.viewBox}"><g fill="${emblem.color}">${paths}</g></symbol>`;
const updated = sprite.replace(/<symbol id="lecturn-file-icon-claude"[\s\S]*?<\/symbol>/, symbol);
if (updated === sprite && !sprite.includes(symbol)) throw new Error("Claude file symbol not found");
writeFileSync(spriteFile, updated);

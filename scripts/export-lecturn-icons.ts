#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone Sharp asset exporter uses Node buffers and filesystem APIs.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import sharp from "sharp";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const source = await NodeFSP.readFile(NodePath.join(root, "assets/lecturn/mark.svg"), "utf8");
const mark = source.replace(/<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const render = (background: string, size: number, mac = false) => {
  const inset = mac ? 100 : 0;
  const side = 1024 - 2 * inset;
  const body = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="${background}"/><stop offset="1" stop-color="#030B13"/></linearGradient></defs><rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${mac ? 184 : 0}" fill="url(#bg)"/><svg x="${inset}" y="${inset}" width="${side}" height="${side}" viewBox="0 0 128 128" fill="none">${mark}</svg></svg>`;
  return sharp(Buffer.from(body)).resize(size, size).png().toBuffer();
};
let count = 0;
async function write(relative: string, data: Buffer | string) {
  const dest = NodePath.join(root, relative);
  if (check) {
    const previous = await NodeFSP.readFile(dest);
    // Repository formatting can change JSON whitespace without changing the icon project.
    const matches = relative.endsWith(".json")
      ? JSON.stringify(JSON.parse(previous.toString())) ===
        JSON.stringify(JSON.parse(Buffer.from(data).toString()))
      : previous.equals(Buffer.from(data));
    if (!matches) throw new Error(`Stale Lecturn asset: ${relative}`);
  } else {
    await NodeFSP.mkdir(NodePath.dirname(dest), { recursive: true });
    await NodeFSP.writeFile(dest, data);
  }
  count++;
}
for (const [prefix, background] of [
  ["production", "#102A39"],
  ["development", "#234552"],
  ["nightly", "#26273E"],
] as const) {
  const get = (suffix: string) =>
    BRAND_ASSET_PATHS[`${prefix}${suffix}` as keyof typeof BRAND_ASSET_PATHS];
  const full = await render(background, 1024);
  await write(get("IosIconPng"), full);
  await write(prefix === "development" ? get("UniversalIconPng") : get("LinuxIconPng"), full);
  await write(
    prefix === "development" ? get("DesktopIconPng") : get("MacIconPng"),
    await render(background, 1024, true),
  );
  const images = await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await render(background, size) })),
  );
  const ico = encodePngIco(images);
  await write(get("WindowsIconIco"), ico);
  await write(get("WebFaviconIco"), ico);
  await write(get("WebFavicon16Png"), await render(background, 16));
  await write(get("WebFavicon32Png"), await render(background, 32));
  await write(get("WebAppleTouchIconPng"), await render(background, 180));
  const project = get("IconComposerProject");
  await write(`${project}/Assets/lecturn.svg`, source);
  await write(
    `${project}/icon.json`,
    JSON.stringify(
      {
        fill: { solid: "display-p3:0.02353,0.08235,0.13333,1.00000" },
        groups: [
          {
            layers: [
              {
                "image-name": "lecturn.svg",
                name: "Illuminated book",
                position: { scale: 8, "translation-in-points": [0, 0] },
              },
            ],
            shadow: { kind: "neutral", opacity: 0.25 },
            translucency: { enabled: false, value: 0 },
          },
        ],
        "supported-platforms": { circles: ["watchOS"], squares: "shared" },
      },
      null,
      2,
    ) + "\n",
  );
}
for (const folder of ["apps/web/public", "apps/marketing/public"]) {
  for (const [suffix, filename] of [
    ["WebFaviconIco", "favicon.ico"],
    ["WebFavicon16Png", "favicon-16x16.png"],
    ["WebFavicon32Png", "favicon-32x32.png"],
    ["WebAppleTouchIconPng", "apple-touch-icon.png"],
  ]) {
    const sourcePath = BRAND_ASSET_PATHS[`production${suffix}` as keyof typeof BRAND_ASSET_PATHS];
    await write(`${folder}/${filename}`, await NodeFSP.readFile(NodePath.join(root, sourcePath)));
  }
  await write(`${folder}/lecturn-mark.svg`, source);
}
await write("assets/prod/logo.svg", source);
await write(
  "apps/marketing/public/icon.webp",
  await sharp(await render("#102A39", 1024))
    .webp({ quality: 95 })
    .toBuffer(),
);
await write("apps/mobile/assets/android-icon-foreground.svg", source);
await write(
  "apps/mobile/assets/android-icon-foreground.png",
  await sharp(Buffer.from(source)).resize(432, 432).png().toBuffer(),
);
const silhouette = source.replace(/#[A-Fa-f0-9]{6}/g, "#FFFFFF");
await write(
  "apps/mobile/assets/android-icon-mark.png",
  await sharp(Buffer.from(silhouette)).resize(432, 432).png().toBuffer(),
);
await write(
  "apps/mobile/assets/android-notification-icon.png",
  await sharp(Buffer.from(silhouette)).resize(96, 96).png().toBuffer(),
);
process.stdout.write(
  `${check ? "Verified" : "Exported"} ${count} Lecturn assets from assets/lecturn/mark.svg\n`,
);

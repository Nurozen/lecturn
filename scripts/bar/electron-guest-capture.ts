// @effect-diagnostics nodeBuiltinImport:off - Host-side capture tooling writing PNG files.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { PNG } from "pngjs";

/** A guest view's rectangle in the host window's content, in CSS pixels. */
export interface GuestBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A window capture never contains its `WebContentsView` guests, so a host
 * screenshot shows an empty pane where the embed is. Both images must be DPR 1,
 * which is what the embed helper's guest capture produces.
 */
export function compositeGuest(windowImage: PNG, guestImage: PNG, bounds: GuestBounds): PNG {
  if (guestImage.width !== bounds.width || guestImage.height !== bounds.height) {
    throw new Error(
      `Guest capture is ${guestImage.width}x${guestImage.height} but its bounds are ${bounds.width}x${bounds.height}; capture both at DPR 1.`,
    );
  }
  const inside =
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= windowImage.width &&
    bounds.y + bounds.height <= windowImage.height;
  if (!inside) {
    throw new Error(
      `Guest bounds ${JSON.stringify(bounds)} leave the ${windowImage.width}x${windowImage.height} window capture.`,
    );
  }
  const out = new PNG({ width: windowImage.width, height: windowImage.height });
  windowImage.data.copy(out.data);
  PNG.bitblt(guestImage, out, 0, 0, bounds.width, bounds.height, bounds.x, bounds.y);
  return out;
}

/**
 * What a host harness hands over: its own DPR-1 window capture, and for each
 * mounted embed its current bounds and the embed helper's guest capture
 * (`@lecturn/embed/electron` capture over the view's one debugger session).
 */
export interface EmbedCompositeSource {
  readonly captureWindow: () => Promise<Buffer>;
  readonly guests: ReadonlyArray<{
    readonly bounds: () => GuestBounds;
    readonly capture: () => Promise<Buffer>;
  }>;
}

export async function captureEmbedComposite(
  source: EmbedCompositeSource,
  outPath?: string,
): Promise<PNG> {
  let image: PNG = PNG.sync.read(await source.captureWindow());
  for (const guest of source.guests) {
    // Bounds are read after the guest capture so a resize while it ran is caught.
    const pixels = PNG.sync.read(await guest.capture());
    image = compositeGuest(image, pixels, guest.bounds());
  }
  if (outPath !== undefined) {
    await NodeFSP.mkdir(NodePath.dirname(outPath), { recursive: true });
    await NodeFSP.writeFile(outPath, PNG.sync.write(image));
  }
  return image;
}

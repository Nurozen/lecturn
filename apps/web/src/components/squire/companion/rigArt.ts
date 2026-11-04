/* Parts are cropped to their alpha bounding box (2 px pad) to cut decoded memory; x/y/w/h place
   each crop in stage units exactly where the full-stage source art sat.
   One fixed shoulder/upper arm; interchangeable forearms meet at the elbow.
   rock: the head rotates about the nape (chin down) or throat (chin up) and the raised hood about
   its back or front base, so painted cut edges slide behind the collar instead of out of it.
   limits: measured seam limits per bone relative to its parent (degrees / stage units); the
   runtime soft-limits every channel to them. grips[*].armMotion optionally scales forearm motion.
   limits.heads[appearance] / limits.heads['appearance-hood'] / limits.grips[equipment] override.
   napeFill[appearance]: region where a static copy of the head (hood down) backs the moving
   head, so the hair/cloak slit at the nape never opens wider when the chin drops (female only;
   on the male head it would double the neck outline). hoodFaceClip sits ~2u under the trim.
   heads[*].feather: [y0,y1] band where the head image fades out (male image ends at y~502).
   napeFill rect fades in over `feather` units on its left and top edges. hoodLining: dark hood
   interior drawn behind the head with the hood transform, under the brim/hair junction. */
import armillaryUrl from "~/assets/squire/companion/armillary.webp";
import astrolabeUrl from "~/assets/squire/companion/astrolabe.webp";
import femaleHeadUrl from "~/assets/squire/companion/female-head.webp";
import grimoireUrl from "~/assets/squire/companion/grimoire.webp";
import helmetUrl from "~/assets/squire/companion/helmet.webp";
import hoodUrl from "~/assets/squire/companion/hood.webp";
import lanceUrl from "~/assets/squire/companion/lance.webp";
import maleHeadUrl from "~/assets/squire/companion/male-head.webp";
import noneUrl from "~/assets/squire/companion/none.webp";
import torsoUrl from "~/assets/squire/companion/torso.webp";

import type { RigArt } from "./types";

/** The male head is a 450x581 source drawn at x:390,y:50,w:350 in v5; its crop scales by this. */
const MALE_SCALE = 350 / 450;

export const RIG_ART: RigArt = {
  stage: [1122, 1402],
  torso: { src: torsoUrl, x: 73, y: 418, w: 1027, h: 970 },
  heads: {
    female: { src: femaleHeadUrl, x: 278, y: 39, w: 493, h: 443 },
    male: {
      src: maleHeadUrl,
      x: 390 + 2 * MALE_SCALE,
      y: 50 + 2 * MALE_SCALE,
      w: 446 * MALE_SCALE,
      h: 577 * MALE_SCALE,
      feather: [470, 502],
    },
  },
  hood: { src: hoodUrl, x: 55, y: 43, w: 1031, h: 489 },
  hoodFaceClip:
    "M658 93 Q718 103 777 164 L812 441 L645 527 L533 476 Q493 430 519 340 Q538 259 572 189 Q609 125 658 93Z",
  grips: {
    helmet: { src: helmetUrl, x: 323, y: 626, w: 755, h: 624 },
    lance: { src: lanceUrl, x: 323, y: 19, w: 742, h: 1342 },
    astrolabe: { src: astrolabeUrl, x: 323, y: 548, w: 745, h: 700 },
    grimoire: { src: grimoireUrl, x: 323, y: 637, w: 737, h: 610 },
    armillary: { src: armillaryUrl, x: 323, y: 599, w: 757, h: 648 },
    none: { src: noneUrl, x: 323, y: 956, w: 623, h: 296 },
  },
  pivots: { body: [550, 1300], head: [560, 440], arm: [400, 990] },
  rock: { nape: [455, 422], throat: [625, 458], hoodBack: [300, 470], hoodFront: [610, 520] },
  limits: {
    body: [-2.5, 3],
    bodyY: [-16, 12],
    head: [-4, 4.5],
    headX: [-2.5, 2],
    headY: [-0.4, 4],
    hood: [-3.5, 2],
    arm: [-2.5, 2],
    armX: [-1.5, 1.5],
    armY: [-1.5, 1.5],
    heads: { female: { headX: [-1.5, 1.6] }, "male-up": { head: [-4, 2] } },
    grips: {
      lance: { arm: [-2.5, 2.5] },
      grimoire: { arm: [-3.5, 3.5] },
      armillary: { arm: [-3.5, 3.5] },
      none: { arm: [-3.5, 3.5] },
    },
  },
  napeFill: { female: { x: 380, y: 388, w: 180, h: 94, feather: 10 } },
  hoodLining: "M628 112 L644 100 L660 90 L674 92 L681 97 L674 101 L660 104 L644 110 L632 122Z",
};

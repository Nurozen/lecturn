#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - A host-side image tool reading and writing PNG files.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface PixelRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PixelOffset {
  readonly dx: number;
  readonly dy: number;
}

export interface PixelDiffOptions {
  /** pixelmatch's per-pixel color distance threshold. The bar uses 0.1. */
  readonly threshold?: number;
  /** Region compared, in baseline coordinates. Defaults to the whole baseline. */
  readonly crop?: PixelRegion;
  /** Where baseline content sits in the candidate, so a shifted layout can be compared. */
  readonly align?: PixelOffset;
}

export interface PixelDiffResult {
  readonly width: number;
  readonly height: number;
  readonly changedPixels: number;
  readonly totalPixels: number;
  readonly percent: number;
  readonly diff: PNG;
}

export const BAR_PIXEL_THRESHOLD = 0.1;

export function extractRegion(image: PNG, region: PixelRegion): PNG {
  const fits =
    Number.isInteger(region.x) &&
    Number.isInteger(region.y) &&
    Number.isInteger(region.width) &&
    Number.isInteger(region.height) &&
    region.x >= 0 &&
    region.y >= 0 &&
    region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= image.width &&
    region.y + region.height <= image.height;
  if (!fits) {
    throw new Error(
      `Region ${JSON.stringify(region)} does not fit inside a ${image.width}x${image.height} image.`,
    );
  }
  const out = new PNG({ width: region.width, height: region.height });
  PNG.bitblt(image, out, region.x, region.y, region.width, region.height, 0, 0);
  return out;
}

export function diffPngs(baseline: PNG, candidate: PNG, options: PixelDiffOptions = {}) {
  const crop = options.crop ?? { x: 0, y: 0, width: baseline.width, height: baseline.height };
  const align = options.align ?? { dx: 0, dy: 0 };
  if (options.crop === undefined && options.align === undefined) {
    if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
      throw new Error(
        `Image sizes differ (${baseline.width}x${baseline.height} vs ${candidate.width}x${candidate.height}); pass a crop.`,
      );
    }
  }
  const left = extractRegion(baseline, crop);
  const right = extractRegion(candidate, { ...crop, x: crop.x + align.dx, y: crop.y + align.dy });
  const diff = new PNG({ width: crop.width, height: crop.height });
  const changedPixels = pixelmatch(left.data, right.data, diff.data, crop.width, crop.height, {
    threshold: options.threshold ?? BAR_PIXEL_THRESHOLD,
  });
  const totalPixels = crop.width * crop.height;
  return {
    width: crop.width,
    height: crop.height,
    changedPixels,
    totalPixels,
    percent: (changedPixels / totalPixels) * 100,
    diff,
  } satisfies PixelDiffResult;
}

export async function readPng(path: string): Promise<PNG> {
  return PNG.sync.read(await NodeFSP.readFile(path));
}

export async function writePng(path: string, image: PNG): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, PNG.sync.write(image));
}

function parseNumbers(value: string, count: number, label: string): ReadonlyArray<number> {
  const numbers = value.split(",").map((part) => Number(part.trim()));
  if (numbers.length !== count || numbers.some((number) => !Number.isFinite(number))) {
    throw new Error(`--${label} expects ${count} comma-separated numbers, got '${value}'.`);
  }
  return numbers;
}

export function parsePixelDiffArgs(args: ReadonlyArray<string>) {
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      out: { type: "string" },
      crop: { type: "string" },
      align: { type: "string" },
      threshold: { type: "string" },
      "max-percent": { type: "string" },
    },
  });
  const [baseline, candidate] = positionals;
  if (baseline === undefined || candidate === undefined || positionals.length !== 2) {
    throw new Error(
      "Usage: node scripts/bar/pixel-diff.ts <baseline.png> <candidate.png> [--out diff.png] [--crop x,y,w,h] [--align dx,dy] [--threshold 0.1] [--max-percent 0.5]",
    );
  }
  const crop = values.crop === undefined ? undefined : parseNumbers(values.crop, 4, "crop");
  const align = values.align === undefined ? undefined : parseNumbers(values.align, 2, "align");
  return {
    baseline,
    candidate,
    out: values.out,
    options: {
      ...(crop === undefined
        ? {}
        : { crop: { x: crop[0]!, y: crop[1]!, width: crop[2]!, height: crop[3]! } }),
      ...(align === undefined ? {} : { align: { dx: align[0]!, dy: align[1]! } }),
      ...(values.threshold === undefined ? {} : { threshold: Number(values.threshold) }),
    } satisfies PixelDiffOptions,
    maxPercent: values["max-percent"] === undefined ? undefined : Number(values["max-percent"]),
  };
}

async function main(): Promise<void> {
  const args = parsePixelDiffArgs(NodeProcess.argv.slice(2));
  const result = diffPngs(
    await readPng(args.baseline),
    await readPng(args.candidate),
    args.options,
  );
  if (args.out !== undefined) await writePng(args.out, result.diff);
  const passed = args.maxPercent === undefined || result.percent <= args.maxPercent;
  NodeProcess.stdout.write(
    `${JSON.stringify(
      {
        baseline: args.baseline,
        candidate: args.candidate,
        ...args.options,
        changedPixels: result.changedPixels,
        totalPixels: result.totalPixels,
        percent: result.percent,
        maxPercent: args.maxPercent ?? null,
        passed,
        diff: args.out ?? null,
      },
      null,
      2,
    )}\n`,
  );
  if (!passed) process.exitCode = 1;
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    NodeProcess.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    NodeProcess.exit(2);
  });
}

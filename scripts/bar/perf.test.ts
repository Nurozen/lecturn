import { describe, expect, it } from "vite-plus/test";

import {
  countFrameEvents,
  median,
  parsePerfArgs,
  perfFailures,
  rendererPidsForUrl,
  type TraceEvent,
} from "./perf.ts";

const GUEST = 41;
const HOST = 42;

const event = (name: string, pid: number, ph = "X", data?: unknown): TraceEvent => ({
  name,
  ph,
  pid,
  ts: 0,
  ...(data === undefined ? {} : { args: { data } }),
});

describe("countFrameEvents", () => {
  it("counts each frame once, only in the traced renderers", () => {
    const events = [
      event("BeginMainThreadFrame", GUEST),
      event("PipelineReporter", GUEST, "b"),
      event("PipelineReporter", GUEST, "e"),
      event("Paint", GUEST, "B"),
      event("Paint", GUEST, "E"),
      // Another renderer's frames and non-frame work do not count.
      event("DrawFrame", HOST),
      event("RunTask", GUEST),
    ];
    expect(countFrameEvents(events, new Set([GUEST]))).toEqual({
      total: 3,
      byName: { BeginMainThreadFrame: 1, PipelineReporter: 1, Paint: 1 },
    });
    expect(countFrameEvents([event("RunTask", GUEST)], new Set([GUEST])).total).toBe(0);
  });
});

describe("rendererPidsForUrl", () => {
  it("finds the renderer of a matching frame at trace start and on later commits", () => {
    const events = [
      event("TracingStartedInBrowser", 1, "I", {
        frames: [
          { url: "http://127.0.0.1:5000/embed/env/project", processId: GUEST },
          { url: "file:///renderer/index.html", processId: HOST },
        ],
      }),
      event("FrameCommittedInBrowser", 1, "I", {
        url: "http://127.0.0.1:5000/embed/env/project/thread",
        processId: 77,
      }),
    ];
    expect([...rendererPidsForUrl(events, (url) => url.includes("/embed/"))].sort()).toEqual([
      GUEST,
      77,
    ]);
    expect(rendererPidsForUrl(events, () => false).size).toBe(0);
  });
});

describe("median", () => {
  it("takes the middle sample, or the mean of the middle two", () => {
    expect(median([900, 3000, 1200])).toBe(1200);
    expect(median([1000, 1400, 1200, 5000])).toBe(1300);
  });
});

describe("perfFailures", () => {
  const passing = {
    reducedMotion: false,
    sidecarColdStartMs: 4_100,
    mount: {
      samplesMs: [1500, 1600, 2600],
      readyMs: [1400, null, 2500],
      medianMs: 1600,
      maxMs: 2600,
    },
    idle: [
      {
        scene: "embed-idle",
        idleMs: 5000,
        prefersReducedMotion: false,
        runningAnimations: [],
        pids: [GUEST],
        frames: 0,
        framesByName: {},
        trace: "t",
      },
    ],
    appsRunningThreads: 0,
  };

  it("passes when every B3 target holds, judging mounts by their median", () => {
    expect(perfFailures(passing)).toEqual([]);
  });

  it("names each missed target", () => {
    const failures = perfFailures({
      reducedMotion: false,
      sidecarColdStartMs: 6_500,
      mount: { ...passing.mount, medianMs: 2_100 },
      idle: [
        { ...passing.idle[0]!, frames: 2, framesByName: { Paint: 2 } },
        { ...passing.idle[0]!, scene: "apps-list-idle", pids: [] },
      ],
      appsRunningThreads: 2,
    });
    expect(failures).toHaveLength(5);
    expect(failures.join("\n")).toMatch(/sidecar cold start took 6500 ms/);
    expect(failures.join("\n")).toMatch(/2100 ms at the median/);
    expect(failures.join("\n")).toMatch(/embed-idle: 2 frame events/);
    expect(failures.join("\n")).toMatch(/apps-list-idle: the trace names no renderer/);
    expect(failures.join("\n")).toMatch(/2 threads still working/);
  });

  it("fails a scene whose page did not take the run's reduced-motion setting", () => {
    const reduced = { ...passing.idle[0]!, prefersReducedMotion: true };
    expect(perfFailures({ ...passing, reducedMotion: true, idle: [reduced] })).toEqual([]);
    expect(perfFailures({ ...passing, reducedMotion: true }).join("\n")).toMatch(
      /embed-idle: the page answered prefers-reduced-motion: reduce with false, but the run asked for true/,
    );
    expect(perfFailures({ ...passing, idle: [reduced] })).toHaveLength(1);
  });
});

describe("parsePerfArgs", () => {
  it("defaults the output under the home and checks the numbers", () => {
    const args = parsePerfArgs(["--home", "/tmp/perf-home"]);
    expect(args).toMatchObject({
      home: "/tmp/perf-home",
      out: "/tmp/perf-home/perf",
      idleMs: 5000,
      samples: 5,
      reducedMotion: false,
    });
    expect(parsePerfArgs(["--home", "/tmp/h", "--reduced-motion"]).reducedMotion).toBe(true);
    expect(() => parsePerfArgs([])).toThrow(/--home/);
    expect(() => parsePerfArgs(["--home", "/tmp/h", "--idle-ms", "10"])).toThrow(/--idle-ms/);
    expect(() => parsePerfArgs(["--home", "/tmp/h", "--samples", "0"])).toThrow(/--samples/);
  });
});

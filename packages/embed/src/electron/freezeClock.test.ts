import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import { freezeClockScript } from "./freezeClock.ts";

const FIXED = Date.UTC(2026, 0, 2, 3, 4, 5);

function frozenRealm() {
  const context = NodeVM.createContext({});
  NodeVM.runInContext(freezeClockScript(FIXED), context);
  return (source: string): unknown => NodeVM.runInContext(source, context);
}

describe("freezeClockScript", () => {
  it("pins the current time while explicit dates stay real", () => {
    const run = frozenRealm();
    expect(run("Date.now()")).toBe(FIXED);
    expect(run("new Date().getTime()")).toBe(FIXED);
    expect(run("new Date(0).toISOString()")).toBe("1970-01-01T00:00:00.000Z");
    expect(run("new Date(2020, 1, 3).getFullYear()")).toBe(2020);
    expect(run("Date()")).toBe(run(`new Date(${FIXED}).toString()`));
    expect(run("Date.parse('2001-01-01T00:00:00Z')")).toBe(Date.UTC(2001, 0, 1));
  });

  it("keeps instanceof, constructor and subclassing intact for page code", () => {
    const run = frozenRealm();
    expect(run("new Date() instanceof Date")).toBe(true);
    expect(run("new Date().constructor === Date")).toBe(true);
    expect(run("class Stamp extends Date {}; new Stamp().getTime()")).toBe(FIXED);
    expect(run("Object.prototype.toString.call(new Date())")).toBe("[object Date]");
  });

  it("refuses a non-finite time instead of shipping a broken shim", () => {
    expect(() => freezeClockScript(Number.NaN)).toThrow(RangeError);
  });
});

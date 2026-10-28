// Playwright's page.clock cannot reach a WebContentsView, so captures pin time
// with this shim through Page.addScriptToEvaluateOnNewDocument. Like
// clock.setFixedTime it fixes Date only; timers and performance keep running so
// loaders and socket backoff still progress.
export function freezeClockScript(fixedTimeMs: number): string {
  if (!Number.isFinite(fixedTimeMs)) {
    throw new RangeError(
      `freezeClock must be a finite epoch millisecond value, got ${fixedTimeMs}`,
    );
  }
  return `(() => {
  const fixed = ${JSON.stringify(fixedTimeMs)};
  const RealDate = globalThis.Date;
  function Date(...args) {
    if (!new.target) return new RealDate(fixed).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [fixed] : args, new.target);
  }
  Object.setPrototypeOf(Date, RealDate);
  Date.prototype = RealDate.prototype;
  Object.defineProperty(RealDate.prototype, "constructor", { value: Date, writable: true, configurable: true });
  Date.now = () => fixed;
  Date.parse = RealDate.parse;
  Date.UTC = RealDate.UTC;
  globalThis.Date = Date;
})();`;
}

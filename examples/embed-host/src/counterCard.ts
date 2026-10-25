/**
 * The counter tool's MCP Apps card, `ui://ex/counter-card`. The counter tool
 * server answers `resources/read` for it with `counterCardResource()`, and
 * Lecturn captures it into the thread when `counter_increment` runs.
 *
 * It has the run card's structure from both approved mockups (content is
 * illustrative): a title row with an icon, a saved state, three stats and a
 * line chart of the counter's history. At 560 px or wider it takes the desktop
 * form ("Saved result" under the title, three boxed tiles); narrower, the embed
 * form (a "Saved" chip, one label/value row per stat). Both forms draw the
 * chart with axes, tick labels and a light grid, and no filled area; a single
 * call is a dot mid-plot. Every color comes from the host's
 * MCP Apps variables, and the curve from `--color-ring-primary`, which Lecturn
 * sets to the thread gold and an embedding host to its own accent.
 *
 * The `data-card-*` attributes are the structure hooks the bar checklists
 * probe (`scripts/bar/checklists`); keep them when restyling.
 *
 * Expected tool result: `structuredContent: { count, by?, history? }`.
 */
export const COUNTER_CARD_URI = "ui://ex/counter-card";
export const COUNTER_CARD_MIME_TYPE = "text/html;profile=mcp-app";

const COUNTER_CARD_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Counter</title>
<style>
  :root {
    color-scheme: light dark;
    --card-bg: var(--color-background-secondary, var(--color-background-primary, Canvas));
    --card-fg: var(--color-text-primary, CanvasText);
    --card-muted: var(--color-text-secondary, GrayText);
    --card-border: var(--color-border-primary, color-mix(in srgb, CanvasText 15%, transparent));
    --card-tile: var(--color-background-tertiary, color-mix(in srgb, CanvasText 5%, transparent));
    --card-accent: var(--color-ring-primary, #dca64e);
    --card-radius: var(--border-radius-md, 8px);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: transparent; }
  body {
    font: 13px/1.4 var(--font-sans, system-ui, sans-serif);
    color: var(--card-fg);
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--card-radius);
    padding: 12px 14px 10px;
  }
  .head { display: flex; align-items: center; gap: 10px; }
  .icon {
    flex: none; display: grid; place-items: center;
    width: 28px; height: 28px; border-radius: calc(var(--card-radius) - 2px);
    background: color-mix(in srgb, var(--card-accent) 16%, transparent);
    color: var(--card-accent);
  }
  .titles { min-width: 0; flex: 1; }
  .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .subtitle { color: var(--card-muted); font-size: 12px; }
  .chip {
    flex: none; font-size: 11px; padding: 1px 8px; border-radius: 999px;
    border: 1px solid var(--card-border); color: var(--card-muted);
  }
  .stats { margin: 12px 0 10px; }
  .stat-label { color: var(--card-muted); }
  .stat-value { font-variant-numeric: tabular-nums; }
  #chart { display: block; width: 100%; height: 168px; overflow: visible; }
  .grid { stroke: var(--card-border); stroke-width: 1; opacity: 0.6; }
  .axis { stroke: var(--card-muted); stroke-width: 1; opacity: 0.7; }
  .tick { fill: var(--card-muted); font: 10px/1 var(--font-sans, system-ui, sans-serif); font-variant-numeric: tabular-nums; }
  .axis-title { fill: var(--card-muted); font: 11px/1 var(--font-sans, system-ui, sans-serif); }
  .curve { fill: none; stroke: var(--card-accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .point { fill: var(--card-accent); }
  .note { color: var(--card-muted); font-size: 12px; margin-top: 6px; }
  .note:empty { display: none; }

  /* Narrow (embed pane): a chip carries the saved state; one label/value row per stat. */
  .subtitle { display: none; }
  .stat { display: grid; grid-template-columns: minmax(0, 45%) minmax(0, 1fr); gap: 8px; padding: 3px 0; }
  .stat-value { font-size: 13px; }

  /* Wide (desktop main pane): a subtitle instead of the chip, three boxed tiles. */
  @media (min-width: 560px) {
    .chip { display: none; }
    .subtitle { display: block; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 12px 0 8px; }
    .stat { display: block; background: var(--card-tile); border: 1px solid var(--card-border);
      border-radius: calc(var(--card-radius) - 2px); padding: 8px 10px; }
    .stat-label { font-size: 11px; }
    .stat-value { font: 600 18px/1.3 var(--font-mono, ui-monospace, monospace); }
    #chart { height: 196px; }
    .tick { font-size: 11px; }
  }

  .card[data-state="cancelled"] .curve, .card[data-state="cancelled"] .point { opacity: 0.35; }
</style>
</head>
<body>
<div class="card" data-state="pending">
  <div class="head" data-card-title>
    <div class="icon" aria-hidden="true" data-card-icon>
      <svg viewBox="0 0 16 16" width="16" height="16"><path d="M2 13 6 8l3 3 5-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div class="titles">
      <div class="title">Counter</div>
      <div class="subtitle" id="subtitle" data-card-subtitle>Running</div>
    </div>
    <span class="chip" id="chip" data-card-chip>Running</span>
  </div>
  <div class="stats">
    <div class="stat" data-card-stat><div class="stat-label">Count</div><div class="stat-value" id="count">–</div></div>
    <div class="stat" data-card-stat><div class="stat-label">Change</div><div class="stat-value" id="change">–</div></div>
    <div class="stat" data-card-stat><div class="stat-label">Calls</div><div class="stat-value" id="calls">–</div></div>
  </div>
  <svg id="chart" data-card-chart role="img" aria-label="Counter history">
    <g id="frame"></g>
    <polyline class="curve" id="curve" points=""/>
    <g id="points"></g>
  </svg>
  <div class="note" id="note"></div>
</div>
<script>
(function () {
  var pending = new Map();
  var nextId = 1;
  var card = document.querySelector(".card");
  var byId = function (id) { return document.getElementById(id); };

  // The stylesheet's query, so data-card-layout always names the form drawn.
  var wide = window.matchMedia("(min-width: 560px)");
  function syncLayout() {
    card.dataset.cardLayout = wide.matches ? "wide" : "narrow";
    if (lastHistory) draw(lastHistory);
  }
  syncLayout();
  wide.addEventListener("change", syncLayout);

  function post(message) { window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, message), "*"); }
  function request(method, params) {
    var id = nextId++;
    post({ id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending.set(id, { resolve: resolve, reject: reject }); });
  }

  function applyContext(context) {
    if (!context) return;
    var variables = context.styles && context.styles.variables;
    if (variables) {
      for (var name in variables) document.documentElement.style.setProperty(name, variables[name]);
    }
    if (context.theme === "light" || context.theme === "dark") {
      document.documentElement.style.colorScheme = context.theme;
    }
  }

  function setSaved(label, subtitle) {
    byId("chip").textContent = label;
    byId("subtitle").textContent = subtitle;
  }

  var SVG = "http://www.w3.org/2000/svg";
  var lastHistory = null;

  // A 1-2-5 step, so tick labels stay round whatever the counter's range.
  function niceStep(raw) {
    var magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    var unit = raw / magnitude;
    return Math.max(1, (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * magnitude);
  }
  function ticks(lo, hi, step) {
    var out = [];
    for (var value = Math.ceil(lo / step) * step; value <= hi + 1e-9; value += step) out.push(value);
    return out;
  }
  function svgEl(tag, attrs, text) {
    var el = document.createElementNS(SVG, tag);
    for (var name in attrs) el.setAttribute(name, String(attrs[name]));
    if (text !== undefined) el.textContent = text;
    return el;
  }

  // Laid out in the chart's own pixel size (jsdom has none, hence the fallbacks)
  // so tick labels are never stretched the way a fixed, unscaled viewBox would.
  function draw(history) {
    lastHistory = history;
    var chart = byId("chart");
    var box = chart.getBoundingClientRect();
    var width = box.width || (wide.matches ? 600 : 300);
    var height = box.height || (wide.matches ? 196 : 168);
    chart.setAttribute("viewBox", "0 0 " + width + " " + height);

    var points = history;
    var single = points.length === 1;
    var xMax = points.length;
    var xTicks = single ? [1] : ticks(1, xMax, niceStep((xMax - 1) / (wide.matches ? 8 : 5)));
    // One call has no range of its own; spanning twice its value puts it mid-plot, not on the top edge.
    var range = single ? [0, points[0] * 2, 2] : points.concat([0, 1]);
    var yLo = Math.min.apply(null, range);
    var yHi = Math.max.apply(null, range);
    var yStep = niceStep((yHi - yLo) / 4);
    yLo = Math.floor(yLo / yStep) * yStep;
    yHi = Math.ceil(yHi / yStep) * yStep;
    var yTicks = ticks(yLo, yHi, yStep);
    var labelChars = Math.max.apply(null, yTicks.map(function (value) { return String(value).length; }));
    var plot = { left: 18 + labelChars * 6.5 + 8, right: width - 10, top: 8, bottom: height - 34 };
    var sx = function (x) {
      if (single) return (plot.left + plot.right) / 2;
      return plot.left + ((x - 1) / (xMax - 1)) * (plot.right - plot.left);
    };
    var sy = function (y) { return plot.bottom - ((y - yLo) / (yHi - yLo)) * (plot.bottom - plot.top); };

    var frame = byId("frame");
    frame.replaceChildren();
    yTicks.forEach(function (value) {
      var y = sy(value);
      if (value !== yLo) frame.append(svgEl("line", { class: "grid", x1: plot.left, y1: y, x2: plot.right, y2: y }));
      frame.append(svgEl("line", { class: "axis", x1: plot.left - 4, y1: y, x2: plot.left, y2: y }));
      frame.append(svgEl("text", { class: "tick", "data-card-tick": "y", x: plot.left - 7, y: y, "text-anchor": "end", "dominant-baseline": "middle" }, String(value)));
    });
    xTicks.forEach(function (value) {
      var x = sx(value);
      if (value !== 1) frame.append(svgEl("line", { class: "grid", x1: x, y1: plot.top, x2: x, y2: plot.bottom }));
      frame.append(svgEl("line", { class: "axis", x1: x, y1: plot.bottom, x2: x, y2: plot.bottom + 4 }));
      frame.append(svgEl("text", { class: "tick", "data-card-tick": "x", x: x, y: plot.bottom + 15, "text-anchor": "middle" }, String(value)));
    });
    frame.append(svgEl("line", { class: "axis", "data-card-axis": "x", x1: plot.left, y1: plot.bottom, x2: plot.right, y2: plot.bottom }));
    frame.append(svgEl("line", { class: "axis", "data-card-axis": "y", x1: plot.left, y1: plot.top, x2: plot.left, y2: plot.bottom }));
    frame.append(svgEl("text", { class: "axis-title", x: (plot.left + plot.right) / 2, y: height - 4, "text-anchor": "middle" }, "Call"));
    var yTitle = (plot.top + plot.bottom) / 2;
    frame.append(svgEl("text", { class: "axis-title", x: 10, y: yTitle, "text-anchor": "middle", transform: "rotate(-90 10 " + yTitle + ")" }, "Count"));

    byId("curve").setAttribute("points", points.map(function (value, index) {
      return sx(index + 1).toFixed(1) + "," + sy(value).toFixed(1);
    }).join(" "));
    // A one-point polyline draws nothing.
    var dots = byId("points");
    dots.replaceChildren();
    if (single) {
      dots.append(svgEl("circle", { class: "point", "data-card-point": "", cx: sx(1), cy: sy(points[0]), r: 3.5 }));
    }
  }

  function showResult(result) {
    var data = (result && result.structuredContent) || {};
    var count = typeof data.count === "number" ? data.count : 0;
    var history = Array.isArray(data.history) && data.history.length > 0
      ? data.history.filter(function (value) { return typeof value === "number"; })
      : [count];
    var by = typeof data.by === "number" ? data.by : history.length > 1 ? count - history[history.length - 2] : count;
    byId("count").textContent = String(count);
    byId("change").textContent = (by >= 0 ? "+" : "") + by;
    byId("calls").textContent = String(history.length);
    draw(history);
    card.dataset.state = result && result.isError ? "error" : "saved";
    if (result && result.isError) setSaved("Failed", "The call failed");
    else setSaved("Saved", "Saved result");
    reportSize();
  }

  function showCancelled(reason) {
    card.dataset.state = "cancelled";
    setSaved("Cancelled", "Not run");
    byId("note").textContent = reason || "The call was cancelled.";
    draw([0]);
    reportSize();
  }

  var lastHeight = 0;
  function reportSize() {
    var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    post({ method: "ui/notifications/size-changed", params: { height: height } });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && message.method === undefined) {
      var waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(message.error); else waiter.resolve(message.result);
      return;
    }
    switch (message.method) {
      case "ui/notifications/host-context-changed": applyContext(message.params); break;
      case "ui/notifications/tool-result": showResult(message.params); break;
      case "ui/notifications/tool-cancelled": showCancelled(message.params && message.params.reason); break;
      case "ui/resource-teardown": post({ id: message.id, result: {} }); break;
    }
  });

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(reportSize).observe(document.body);
    new ResizeObserver(function () { if (lastHistory) draw(lastHistory); }).observe(byId("chart"));
  }

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "counter-card", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then(function (result) {
    applyContext(result && result.hostContext);
    post({ method: "ui/notifications/initialized", params: {} });
    reportSize();
  });
})();
</script>
</body>
</html>
`;

export const counterCardResource = () => ({
  uri: COUNTER_CARD_URI,
  mimeType: COUNTER_CARD_MIME_TYPE,
  text: COUNTER_CARD_HTML,
  _meta: { ui: { prefersBorder: false } },
});

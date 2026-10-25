/**
 * The counter tool's MCP Apps card, `ui://ex/counter-card`. The counter tool
 * server answers `resources/read` for it with `counterCardResource()`, and
 * Lecturn captures it into the thread when `counter_increment` runs.
 *
 * It has the run card's structure from both approved mockups (content is
 * illustrative): a title row with an icon, a saved state, three stats and a
 * line chart of the counter's history. At 560 px or wider it takes the desktop
 * form ("Saved result" under the title, three boxed tiles); narrower, the embed
 * form (a "Saved" chip, stats in a row). Every color comes from the host's
 * MCP Apps variables, and the curve from `--color-ring-primary`, which Lecturn
 * sets to the thread gold and an embedding host to its own accent.
 *
 * Expected tool result: `structuredContent: { count, by?, history? }`.
 */
export const COUNTER_CARD_URI = "ui://ex/counter-card";
export const COUNTER_CARD_MIME_TYPE = "text/html;profile=mcp-app";

export const COUNTER_CARD_HTML = `<!doctype html>
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
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 12px 0 8px; }
  .stat-label { color: var(--card-muted); font-size: 11px; }
  .stat-value { font: 600 15px/1.3 var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
  #chart { display: block; width: 100%; height: 88px; overflow: visible; }
  .grid { stroke: var(--card-border); stroke-width: 1; }
  .curve { fill: none; stroke: var(--card-accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .area { fill: color-mix(in srgb, var(--card-accent) 14%, transparent); stroke: none; }
  .dot { fill: var(--card-accent); }
  .note { color: var(--card-muted); font-size: 12px; margin-top: 6px; }
  .note:empty { display: none; }

  /* Narrow (embed pane): a chip carries the saved state; stats sit in a row. */
  .subtitle { display: none; }
  .stat { display: flex; align-items: baseline; gap: 6px; }

  /* Wide (desktop main pane): a subtitle instead of the chip, boxed tiles. */
  @media (min-width: 560px) {
    .chip { display: none; }
    .subtitle { display: block; }
    .stat { display: block; background: var(--card-tile); border: 1px solid var(--card-border);
      border-radius: calc(var(--card-radius) - 2px); padding: 8px 10px; }
    .stat-value { font-size: 18px; }
    #chart { height: 120px; }
  }

  .card[data-state="cancelled"] .curve,
  .card[data-state="cancelled"] .area,
  .card[data-state="cancelled"] .dot { opacity: 0.35; }
</style>
</head>
<body>
<div class="card" data-state="pending">
  <div class="head">
    <div class="icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16"><path d="M2 13 6 8l3 3 5-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div class="titles">
      <div class="title">Counter</div>
      <div class="subtitle" id="subtitle">Running</div>
    </div>
    <span class="chip" id="chip">Running</span>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-label">Count</div><div class="stat-value" id="count">–</div></div>
    <div class="stat"><div class="stat-label">Change</div><div class="stat-value" id="change">–</div></div>
    <div class="stat"><div class="stat-label">Calls</div><div class="stat-value" id="calls">–</div></div>
  </div>
  <svg id="chart" viewBox="0 0 300 100" preserveAspectRatio="none" role="img" aria-label="Counter history">
    <line class="grid" x1="0" y1="99.5" x2="300" y2="99.5"/>
    <path class="area" id="area" d=""/>
    <polyline class="curve" id="curve" points="" vector-effect="non-scaling-stroke"/>
  </svg>
  <div class="note" id="note"></div>
</div>
<script>
(function () {
  var pending = new Map();
  var nextId = 1;
  var card = document.querySelector(".card");
  var byId = function (id) { return document.getElementById(id); };

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

  function draw(history) {
    var points = history.length === 1 ? [history[0], history[0]] : history;
    var max = Math.max.apply(null, points.concat([1]));
    var min = Math.min.apply(null, points.concat([0]));
    var span = max - min || 1;
    var coords = points.map(function (value, index) {
      var x = (index / (points.length - 1)) * 300;
      var y = 96 - ((value - min) / span) * 88;
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    byId("curve").setAttribute("points", coords.join(" "));
    byId("area").setAttribute("d", "M0,100 L" + coords.join(" L") + " L300,100 Z");
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

  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.body);

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

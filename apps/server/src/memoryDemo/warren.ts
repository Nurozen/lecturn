/**
 * warren - deterministic synthetic warren for the memory demo, ported from the
 * design mockup's map generator (`05_map.js` buildGraph / forceLayout /
 * nodeText). Seed `mulberry(20260918)` yields exactly 1,500 generated nodes
 * across ten territories; the spike fixture's warren nodes are mapped into
 * those territories with scores high enough to sit in each top 40.
 *
 * `buildWarren` is cheap (a few ms) and `layoutWarren` is the expensive part;
 * the store calls both lazily, only when the demo flag is on.
 *
 * Coordinates: territory `x`/`y` are map layout units. Node `x`/`y` are
 * territory-local layout units, relative to their territory's centre, as in
 * the mockup's per-territory view.
 *
 * @module warren
 */
import type { MemoryJudgments, MemoryNodeType } from "@lecturn/contracts";
import { denSeedIds, recordedJudgments, type SpikeFixture } from "./spikeFixture.ts";

/** Mockup PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a hash. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Lowercase kebab slug; camelCase splits into words. */
export function slugify(text: string, maxLength = 60): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

const TC: Record<string, MemoryNodeType> = {
  f: "function",
  m: "module",
  c: "class",
  i: "interface",
  k: "concept",
  d: "decision",
  r: "reference",
  x: "composite",
};

export interface TerritorySpec {
  readonly id: string;
  readonly label: string;
  readonly project: string;
  readonly n: number;
  readonly dom: MemoryNodeType;
  readonly kw: readonly string[];
  readonly path: string;
  readonly stems: string;
}

export const TERRITORIES: readonly TerritorySpec[] = [
  {
    id: "auth",
    label: "auth",
    project: "harbor-api",
    n: 212,
    dom: "function",
    kw: [
      "auth",
      "login",
      "session",
      "token",
      "refresh",
      "oauth",
      "password",
      "cookie",
      "flow",
      "mfa",
    ],
    path: "src/auth",
    stems:
      "rotateSession|f,Refresh tokens rotate on every use|d,issueTokenPair|f,SessionStore|c,oauthCallback|f,Login flow: password, MFA, session|k,csrfGuard|f,auth/middleware|m,AuthProvider|i,verifyPassword|f,Session cookie policy|d,mfaChallenge|f,loginThrottle|f,PasswordHasher|c,revokeSessionFamily|f,OWASP session management|r,Device binding|k,requireUser|f",
  },
  {
    id: "billing",
    label: "billing",
    project: "harbor-api",
    n: 248,
    dom: "class",
    kw: [
      "billing",
      "invoice",
      "credit",
      "ledger",
      "stripe",
      "charge",
      "payment",
      "plan",
      "subscription",
    ],
    path: "src/billing",
    stems:
      "Ledger|c,Ledger entries are append-only|d,applyInvoiceCredit|f,Invoice|c,billing/core|m,Subscription|c,prorateUpgrade|f,Money uses integer cents|d,createCheckoutSession|f,InvoiceRenderer|c,TaxProvider|i,chargeCustomer|f,Plan catalog|k,Dunning schedule|k,refundCharge|f,Stripe API versions|r,PaymentMethod|c,closeBillingPeriod|f",
  },
  {
    id: "webhooks",
    label: "webhooks",
    project: "harbor-api",
    n: 131,
    dom: "function",
    kw: [
      "webhook",
      "webhooks",
      "retry",
      "retries",
      "idempotent",
      "idempotency",
      "event",
      "delivery",
      "backoff",
      "signature",
      "policy",
    ],
    path: "src/billing/webhooks",
    stems:
      "processStripeEvent|f,Webhook handler is idempotent by event id|d,scheduleRetry|f,WebhookDelivery|c,Retry backoff schedule|k,verifySignature|f,RetryPolicy|i,Dead letter after 5 attempts|d,enqueueDeadLetter|f,billing/webhooks|m,Replay protection window|k,Stripe docs: event ordering|r,processed_events table|k,dispatchEvent|f,WebhookRouter|c,retry jitter|k",
  },
  {
    id: "migrations",
    label: "migrations",
    project: "harbor-api",
    n: 96,
    dom: "concept",
    kw: ["migration", "migrations", "migrate", "schema", "alembic", "deploy", "run", "boot"],
    path: "db/migrations",
    stems:
      "Migrations run with make migrate|k,Never migrate on boot|d,schemaVersionGuard|f,db/migrations|m,Backfill in batches of 5k|d,Zero-downtime column rename|k,migrate.ts|m,rollbackLast|f,Migration naming|k,Deploy job order|k,lockTimeout|f,Expand then contract|r",
  },
  {
    id: "api-errors",
    label: "api/errors",
    project: "harbor-api",
    n: 167,
    dom: "class",
    kw: ["error", "errors", "problem", "json", "api", "status", "catalog", "validation"],
    path: "src/api/errors",
    stems:
      "ProblemError|c,API errors use problem+json|d,errors/catalog|m,toProblem|f,ValidationError|c,errorMiddleware|f,Error codes are stable|d,RateLimitError|c,RFC 9457|r,mapZodIssues|f,ErrorCode|i,NotFoundError|c,Retryable vs fatal|k,withRequestId|f",
  },
  {
    id: "data-models",
    label: "data/models",
    project: "harbor-api",
    n: 159,
    dom: "class",
    kw: ["model", "models", "table", "schema", "orm", "entity", "customer", "order"],
    path: "src/data",
    stems:
      "Customer|c,Order|c,Repository|i,Soft delete with deleted_at|d,OrderItem|c,data/models|m,withTransaction|f,User|c,Organization|c,UUIDv7 primary keys|d,paginate|f,AuditLog|c,Timestamps in UTC|k,findOrThrow|f",
  },
  {
    id: "web-checkout",
    label: "web/checkout",
    project: "harbor-web",
    n: 183,
    dom: "function",
    kw: ["checkout", "cart", "web", "page", "form", "react", "return", "redirect", "order"],
    path: "app/checkout",
    stems:
      "useCheckout|f,CheckoutForm|c,Success page polls order status|k,app/checkout|m,confirmPayment|f,CartProvider|c,Stripe return URL keeps session|d,AddressForm|c,useCart|f,PriceSummary|c,Optimistic cart updates|k,formatMoney|f,PaymentElement docs|r,PromoCodeInput|c",
  },
  {
    id: "tests-e2e",
    label: "tests/e2e",
    project: "harbor-web",
    n: 142,
    dom: "concept",
    kw: ["test", "tests", "e2e", "flaky", "playwright", "ci", "timeout", "fixture", "spec"],
    path: "e2e",
    stems:
      "Flaky: checkout e2e cold start|k,checkout.spec|m,Flaky: invoice pdf near midnight|k,frozen_clock fixture|f,globalSetup warms Stripe mock|f,Use the 4 vCPU pool|d,loginAs|f,seedOrder|f,Retries are off in CI|d,e2e/fixtures|m,Trace on first retry|k,Playwright sharding|r",
  },
  {
    id: "conventions",
    label: "conventions",
    project: "harbor-web",
    n: 74,
    dom: "decision",
    kw: ["convention", "conventions", "style", "naming", "lint", "commit", "review"],
    path: "docs/conventions",
    stems:
      "Conventional commits|d,No default exports|d,Feature folders|k,Zod at every boundary|d,Naming: verbs for functions|k,One concern per PR|d,ADR template|r,Logging fields|k,Env vars via config.ts|d",
  },
  {
    id: "infra-ci",
    label: "infra/ci",
    project: "harbor-infra",
    n: 88,
    dom: "module",
    kw: ["ci", "infra", "terraform", "pipeline", "runner", "docker", "cache", "build"],
    path: "infra",
    stems:
      "ci/pipeline|m,deploy job|m,Runner pools|k,Docker layer cache|k,terraform/modules/api|m,Preview envs per PR|d,rollback.sh|f,Secrets from SSM|d,buildImage|f,Cache key includes lockfile|k",
  },
];

export const TERRITORY_PAIRS: ReadonlyArray<readonly [string, string, number]> = [
  ["auth", "api-errors", 14],
  ["auth", "data-models", 18],
  ["billing", "webhooks", 26],
  ["billing", "data-models", 22],
  ["billing", "migrations", 9],
  ["webhooks", "api-errors", 11],
  ["migrations", "data-models", 24],
  ["web-checkout", "billing", 16],
  ["web-checkout", "auth", 12],
  ["tests-e2e", "web-checkout", 21],
  ["tests-e2e", "billing", 8],
  ["infra-ci", "tests-e2e", 10],
  ["infra-ci", "migrations", 7],
  ["conventions", "api-errors", 9],
  ["conventions", "web-checkout", 8],
];

const VARIANTS = [
  "tests",
  "legacy path",
  "admin",
  "worker",
  "cli",
  "retry path",
  "edge cases",
  "notes",
  "v2",
  "fixtures",
  "metrics",
  "docs",
];

/** Nodes per territory the map draws; the rest are summarized as "+N more". */
export const TOP_PER_TERRITORY = 40;
export const GENERATED_NODE_COUNT = TERRITORIES.reduce((sum, t) => sum + t.n, 0);
const territoryById = new Map(TERRITORIES.map((t) => [t.id, t]));

export function territorySpec(id: string): TerritorySpec {
  return territoryById.get(id) ?? TERRITORIES[0]!;
}

const NAMESPACE_TERRITORY: Record<string, string> = {
  billing: "billing",
  auth: "auth",
  api: "api-errors",
  web: "web-checkout",
  infra: "infra-ci",
  migrations: "migrations",
  team: "conventions",
  conventions: "conventions",
  webhooks: "webhooks",
};

/**
 * Territory for a fixture or den node: `conventions/*` ids go to conventions,
 * anything about webhooks to webhooks, then by namespace, then by the
 * territory whose keywords the text mentions most.
 */
export function territoryFor(node: {
  readonly id: string;
  readonly namespace: string;
  readonly sourcePath: string | null;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly context: string;
}): string {
  if (node.id.startsWith("conventions/")) return "conventions";
  const pathish = `${node.id} ${node.sourcePath ?? ""} ${node.tags.join(" ")}`.toLowerCase();
  if (pathish.includes("webhook")) return "webhooks";
  const byNamespace = NAMESPACE_TERRITORY[node.namespace];
  if (byNamespace) return byNamespace;
  const words = new Set(
    `${node.summary} ${node.context} ${node.tags.join(" ")} ${node.sourcePath ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9]+/),
  );
  let best = "conventions";
  let bestHits = 0;
  for (const territory of TERRITORIES) {
    const hits = territory.kw.filter((kw) => words.has(kw)).length;
    if (hits > bestHits) {
      best = territory.id;
      bestHits = hits;
    }
  }
  return best;
}

export interface WarrenNode {
  readonly index: number;
  readonly id: string;
  readonly territoryId: string;
  readonly type: MemoryNodeType;
  readonly label: string;
  readonly summary: string;
  readonly context: string;
  readonly tags: readonly string[];
  readonly sourcePath: string | null;
  readonly score: number;
  readonly stale: boolean;
  /** Recorded Jev judgments for spike nodes; null for generated nodes. */
  readonly judgments: MemoryJudgments | null;
}

export interface WarrenTerritory {
  readonly spec: TerritorySpec;
  /** Every node index in this territory. */
  readonly nodeIndexes: readonly number[];
  /** Top nodes by score, at most `TOP_PER_TERRITORY`. */
  readonly top: readonly number[];
}

export interface Warren {
  readonly nodes: readonly WarrenNode[];
  readonly adjacency: ReadonlyArray<readonly number[]>;
  readonly byId: ReadonlyMap<string, number>;
  readonly territories: readonly WarrenTerritory[];
  readonly generatedCount: number;
}

interface DraftNode {
  territory: TerritorySpec;
  name: string;
  type: MemoryNodeType;
  score: number;
  stale: boolean;
  seed: number;
}

/** Port of the mockup's `nodeText`, including its PRNG draw order. */
function nodeText(
  node: DraftNode,
  degree: number,
  neighborName: string,
): { summary: string; context: string; sourcePath: string } {
  const r = mulberry(node.seed);
  const pick = <T>(options: readonly T[]): T => options[Math.floor(r() * options.length)]!;
  const t = node.territory;
  // The mockup builds every lead in one object literal, so every pick runs.
  const leads: Partial<Record<MemoryNodeType, string>> = {
    function: `${node.name} ${pick(["is the single entry point for this path", "validates its input before anything else runs", "wraps the external call and normalizes its errors", "runs on every request that reaches this territory"])}. Most connected to "${neighborName}".`,
    class: `${node.name} ${pick(["owns the state for this part of the system", "is the aggregate root here", "models one persisted row"])}. Most connected to "${neighborName}".`,
    module: `${node.name} groups everything ${t.label} exposes to the rest of ${t.project}.`,
    interface: `${node.name} is a seam in ${t.label}. Two implementations exist, one real and one for tests.`,
    concept: `${node.name}. ${pick(["Found while debugging, written down so nobody rediscovers it.", "This trips up new threads about once a month.", "Agents kept getting this wrong before the note existed."])}`,
    decision: `Decided: ${node.name}. ${pick(["Chosen after an incident review, alternatives are listed in the context.", "Recorded so agents stop reopening the question."])}`,
    reference: `External reference: ${node.name}. Linked from "${neighborName}".`,
    composite: `${node.name} groups related nodes in ${t.label}.`,
  };
  const tail = pick([
    "Touch it together with its tests.",
    "Changes here need a migration note.",
    "Safe to refactor, covered by integration tests.",
    "Has one caller outside its territory.",
  ]);
  const fileStem =
    node.name
      .replace(/[^A-Za-z0-9_]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 28) || "index";
  const file = `${t.path}/${fileStem}.ts`;
  const context =
    node.type === "function"
      ? `// ${file}:L${20 + Math.floor(r() * 80)}\nexport async function ${node.name.replace(/[^A-Za-z0-9_]/g, "") || "fn"}(input)`
      : `${file}\nedges ${degree}, score ${node.score.toFixed(1)}`;
  return { summary: `${leads[node.type] ?? node.name} ${tail}`, context, sourcePath: file };
}

/** Builds the base warren: 1,500 generated nodes plus the spike's warren nodes. */
export function buildWarren(fixture: SpikeFixture): Warren {
  const r = mulberry(20260918);
  const drafts: DraftNode[] = [];
  const adjacency: number[][] = [];
  const territoryNodes = new Map<string, number[]>();

  // Mockup buildGraph, draw for draw.
  for (const territory of TERRITORIES) {
    const stems = territory.stems.split(",").map((stem) => stem.split("|"));
    const indexes: number[] = [];
    for (let i = 0; i < territory.n; i++) {
      const stem = stems[i % stems.length]!;
      const generation = Math.floor(i / stems.length);
      const name = generation
        ? `${stem[0]} (${VARIANTS[(generation - 1 + i) % VARIANTS.length]})`
        : stem[0]!;
      const score = 90 / (1 + i * 0.13) + r() * 5;
      const stale = r() < 0.08;
      const seed = Math.floor(r() * 1e6);
      indexes.push(drafts.length);
      drafts.push({ territory, name, type: TC[stem[1]!] ?? "concept", score, stale, seed });
      adjacency.push([]);
    }
    territoryNodes.set(territory.id, indexes);
  }
  const link = (a: number, b: number) => {
    if (a === b || adjacency[a]!.includes(b)) return;
    adjacency[a]!.push(b);
    adjacency[b]!.push(a);
  };
  for (const territory of TERRITORIES) {
    const indexes = territoryNodes.get(territory.id)!;
    for (let i = 1; i < territory.n; i++) {
      link(indexes[i]!, indexes[Math.floor(r() * r() * i)]!);
      if (r() < 0.4) link(indexes[i]!, indexes[Math.floor(r() * i)]!);
    }
  }
  for (const [a, b, weight] of TERRITORY_PAIRS) {
    const left = territoryNodes.get(a)!;
    const right = territoryNodes.get(b)!;
    for (let i = 0; i < weight; i++) {
      link(left[Math.floor(r() * r() * 50)]!, right[Math.floor(r() * r() * 50)]!);
    }
  }
  const generatedDegree = adjacency.map((edges) => edges.length);
  for (let i = 0; i < drafts.length; i++) drafts[i]!.score += generatedDegree[i]! * 1.5;
  const generatedCount = drafts.length;

  const nodes: WarrenNode[] = [];
  const usedIds = new Set<string>([
    ...fixture.nodes.map((node) => node.id),
    ...fixture.pairs.flatMap((pair) => [pair.a.id, pair.b.id]),
  ]);
  for (let i = 0; i < generatedCount; i++) {
    const draft = drafts[i]!;
    const base = `${draft.territory.id}/${slugify(draft.name) || "node"}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    const neighbor = adjacency[i]![0];
    const text = nodeText(
      draft,
      generatedDegree[i]!,
      neighbor === undefined ? draft.territory.label : drafts[neighbor]!.name,
    );
    nodes.push({
      index: i,
      id,
      territoryId: draft.territory.id,
      type: draft.type,
      label: draft.name.slice(0, 80),
      summary: text.summary,
      context: text.context,
      tags: [draft.territory.id],
      sourcePath: text.sourcePath,
      score: draft.score,
      stale: draft.stale,
      judgments: null,
    });
  }

  // Spike warren nodes: every fixture node that does not seed a den.
  const denIds = new Set(denSeedIds(fixture));
  const spikeNodes = fixture.nodes.filter((node) => !denIds.has(node.id));
  const spikeRank = new Map<string, number>();
  const topGenerated = new Map<string, number>();
  for (const [territoryId, indexes] of territoryNodes) {
    topGenerated.set(territoryId, Math.max(...indexes.map((i) => nodes[i]!.score)));
  }
  const spikeRng = mulberry(20260918 ^ 0x5eed);
  for (const spike of spikeNodes) {
    const territoryId = territoryFor(spike);
    const rank = spikeRank.get(territoryId) ?? 0;
    spikeRank.set(territoryId, rank + 1);
    const index = nodes.length;
    nodes.push({
      index,
      id: spike.id,
      territoryId,
      type: spike.type,
      label: spike.id.slice(0, 80),
      summary: spike.summary,
      context: spike.context,
      tags: spike.tags,
      sourcePath: spike.sourcePath,
      score: topGenerated.get(territoryId)! * Math.max(0.3, 0.92 - 0.035 * rank),
      stale: false,
      judgments: recordedJudgments(fixture, spike, null),
    });
    adjacency.push([]);
    territoryNodes.get(territoryId)!.push(index);
    const generated = territoryNodes.get(territoryId)!;
    link(index, generated[Math.floor(spikeRng() * spikeRng() * 12)]!);
    link(index, generated[Math.floor(spikeRng() * 30)]!);
  }
  const byId = new Map(nodes.map((node) => [node.id, node.index]));
  for (const spike of spikeNodes) {
    for (const edge of spike.edges) {
      const target = byId.get(edge.target);
      if (target !== undefined) link(byId.get(spike.id)!, target);
    }
  }

  const territories = TERRITORIES.map((spec) => {
    const nodeIndexes = territoryNodes.get(spec.id)!;
    const top = [...nodeIndexes]
      .sort((a, b) => nodes[b]!.score - nodes[a]!.score)
      .slice(0, TOP_PER_TERRITORY);
    return { spec, nodeIndexes, top };
  });
  return { nodes, adjacency, byId, territories, generatedCount };
}

interface Point {
  x: number;
  y: number;
}

/** Mockup force layout: repulsion, weighted springs, gravity, cooling. */
function forceLayout(
  points: Point[],
  links: ReadonlyArray<readonly [number, number, number]>,
  iterations: number,
  size: number,
) {
  const n = points.length;
  if (n === 0) return;
  const k = (size / Math.sqrt(n)) * 0.95;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    const temperature = size * 0.1 * (1 - it / iterations) + 0.4;
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let x = points[i]!.x - points[j]!.x;
        let y = points[i]!.y - points[j]!.y;
        let d2 = x * x + y * y;
        if (d2 < 0.01) {
          x = 0.1;
          y = 0.1;
          d2 = 0.02;
        }
        const f = (k * k) / d2;
        dx[i]! += x * f;
        dy[i]! += y * f;
        dx[j]! -= x * f;
        dy[j]! -= y * f;
      }
    }
    for (const [a, b, w] of links) {
      const x = points[a]!.x - points[b]!.x;
      const y = points[a]!.y - points[b]!.y;
      const d = Math.sqrt(x * x + y * y) || 0.01;
      const f = (d / k) * (w || 1);
      dx[a]! -= x * f;
      dy[a]! -= y * f;
      dx[b]! += x * f;
      dy[b]! += y * f;
    }
    for (let i = 0; i < n; i++) {
      dx[i]! -= points[i]!.x * 0.06;
      dy[i]! -= points[i]!.y * 0.06;
      const length = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!) || 1;
      const move = Math.min(length, temperature);
      points[i]!.x += (dx[i]! / length) * move;
      points[i]!.y += (dy[i]! / length) * move;
    }
  }
}

export interface WarrenLayout {
  /** Territory centres in map layout units. */
  readonly territories: ReadonlyMap<string, Point>;
  /** Territory-local positions of each territory's top nodes, by node index. */
  readonly nodes: ReadonlyMap<number, Point>;
}

/** Lays out territories and each territory's top nodes, as the mockup's runLayout. */
export function layoutWarren(warren: Warren): WarrenLayout {
  const territoryIndex = new Map(warren.territories.map((t, i) => [t.spec.id, i]));
  const r = mulberry(5);
  const centres = warren.territories.map((_, i) => ({
    x: Math.cos(i * 0.63) * 260 + r() * 20,
    y: Math.sin(i * 0.63) * 200 + r() * 20,
  }));
  forceLayout(
    centres,
    TERRITORY_PAIRS.map(
      ([a, b, w]) => [territoryIndex.get(a)!, territoryIndex.get(b)!, 0.35 + w / 40] as const,
    ),
    300,
    760,
  );
  const territories = new Map(
    warren.territories.map((t, i) => [
      t.spec.id,
      { x: centres[i]!.x * 1.25, y: centres[i]!.y * 0.82 },
    ]),
  );

  const nodes = new Map<number, Point>();
  warren.territories.forEach((territory, ti) => {
    const rng = mulberry(ti + 11);
    const local = new Map(territory.top.map((nodeIndex, i) => [nodeIndex, i]));
    const points = territory.top.map((_, i) => ({
      x: Math.cos(i * 2.4) * (30 + i * 7) + rng() * 4,
      y: Math.sin(i * 2.4) * (30 + i * 7) + rng() * 4,
    }));
    const links: Array<readonly [number, number, number]> = [];
    territory.top.forEach((nodeIndex, i) => {
      for (const neighbor of warren.adjacency[nodeIndex]!) {
        const j = local.get(neighbor);
        if (j !== undefined && j > i) links.push([i, j, 0.3]);
      }
    });
    forceLayout(points, links, 300, 640);
    for (let it = 0; it < 40; it++) {
      for (let a = 0; a < points.length; a++) {
        for (let b = a + 1; b < points.length; b++) {
          const x = points[a]!.x - points[b]!.x;
          const y = points[a]!.y - points[b]!.y;
          const d = Math.hypot(x, y) || 0.1;
          if (d < 58) {
            const push = (58 - d) / 2 / d;
            points[a]!.x += x * push;
            points[a]!.y += y * push;
            points[b]!.x -= x * push;
            points[b]!.y -= y * push;
          }
        }
      }
    }
    territory.top.forEach((nodeIndex, i) => {
      nodes.set(nodeIndex, { x: points[i]!.x * 1.55, y: points[i]!.y * 0.78 });
    });
  });
  return { territories, nodes };
}

/** A stable position near `anchor`, jittered by a hash of `id`. */
export function jitterNear(anchor: Point, id: string): Point {
  const r = mulberry(fnv1a(id));
  const angle = r() * Math.PI * 2;
  const radius = 36 + r() * 24;
  return { x: anchor.x + Math.cos(angle) * radius, y: anchor.y + Math.sin(angle) * radius };
}

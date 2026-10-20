import type { ProjectIconOverride } from "@lecturn/contracts";
import dynamicIconImports from "lucide-react/dynamicIconImports";
import { deriveProjectIdentity } from "../../projectIdentity";

const colors = {
  gray: "#9ca3af",
  red: "#f87171",
  orange: "#fb923c",
  amber: "#fbbf24",
  yellow: "#facc15",
  lime: "#a3e635",
  green: "#4ade80",
  emerald: "#34d399",
  teal: "#2dd4bf",
  cyan: "#22d3ee",
  sky: "#38bdf8",
  blue: "#60a5fa",
  indigo: "#818cf8",
  violet: "#a78bfa",
  purple: "#c084fc",
  fuchsia: "#e879f9",
  pink: "#f472b6",
  rose: "#fb7185",
};

/** Configured icon, else the same generated monogram the sidebar shows for the project. */
export function activityProjectIcon(
  title: string,
  override?: ProjectIconOverride | null,
): ProjectIconOverride {
  if (override) return override;
  const identity = deriveProjectIdentity(title);
  return { kind: "monogram", text: identity.monogram, color: identity.color };
}

const cache = new Map<string, Promise<string | undefined>>();
const xml = (value: string | number) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
  );
/** Render local catalog geometry as an inert image; no HTML or external resource URLs cross IPC. */
export function loadActivityProjectIcon(icon: ProjectIconOverride): Promise<string | undefined> {
  if (icon.kind === "monogram") {
    const text = Array.from(icon.text).slice(0, 2).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="none" stroke="${colors[icon.color]}" stroke-width="2"/><text x="12" y="16" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${text.length > 1 ? 10 : 12}" font-weight="600" fill="${colors[icon.color]}">${xml(text)}</text></svg>`;
    const url = `data:image/svg+xml;base64,${btoa(String.fromCodePoint(...new TextEncoder().encode(svg)))}`;
    return Promise.resolve(url.length <= 16384 ? url : undefined);
  }
  if (icon.kind !== "lucide") return Promise.resolve(undefined);
  const key = `${icon.name}:${icon.color}`;
  const prior = cache.get(key);
  if (prior) return prior;
  const loader = Object.hasOwn(dynamicIconImports, icon.name)
    ? dynamicIconImports[icon.name as keyof typeof dynamicIconImports]
    : undefined;
  if (!loader) return Promise.resolve(undefined);
  const pending = loader()
    .then((module) => {
      const tags = new Set(["path", "circle", "rect", "ellipse", "line", "polyline", "polygon"]);
      const attrs = new Set([
        "d",
        "x",
        "y",
        "width",
        "height",
        "rx",
        "ry",
        "cx",
        "cy",
        "r",
        "x1",
        "x2",
        "y1",
        "y2",
        "points",
      ]);
      const geometry = module.__iconNode
        .filter(([tag]) => tags.has(tag))
        .map(
          ([tag, properties]) =>
            `<${tag} ${Object.entries(properties)
              .filter(
                ([name, value]) =>
                  attrs.has(name) && (typeof value === "number" || typeof value === "string"),
              )
              .map(([name, value]) => `${name}="${xml(value)}"`)
              .join(" ")}/>`,
        )
        .join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${colors[icon.color]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${geometry}</svg>`;
      const url = `data:image/svg+xml;base64,${btoa(svg)}`;
      return url.length <= 16384 ? url : undefined;
    })
    .catch(() => undefined);
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(key, pending);
  return pending;
}

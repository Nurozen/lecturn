let snapshotSequence = 0;
const pendingExits = new WeakMap<HTMLElement, () => void>();

export function revealTimeline(viewport: HTMLDivElement) {
  for (const snapshot of viewport.parentElement?.querySelectorAll<HTMLElement>(
    ":scope > [data-timeline-exit]",
  ) ?? [])
    pendingExits.get(snapshot)?.();
}

/** Leave an inert, short-lived visual behind while the next virtual list lays out.
 * It stays in the same styling scope and never retains a live React thread. */
export function fadeOutTimeline(viewport: HTMLDivElement) {
  if (!viewport.isConnected || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    return;
  const opacity = Number(getComputedStyle(viewport).opacity);
  if (opacity === 0) return;
  const parent = viewport.parentElement;
  if (!parent) return;
  const snapshot = viewport.cloneNode(true) as HTMLDivElement;
  snapshot.inert = true;
  snapshot.setAttribute("aria-hidden", "true");
  snapshot.removeAttribute("data-assistant-citation-viewport");
  snapshot.setAttribute("data-timeline-exit", "");
  // IDs belong only to the live timeline; the outgoing copy is purely visual.
  const prefix = `timeline-exit-${++snapshotSequence}-`;
  const elements = [snapshot, ...snapshot.querySelectorAll<HTMLElement>("*")];
  const ids = new Map(
    elements.filter((node) => node.id).map((node) => [node.id, prefix + node.id]),
  );
  for (const node of elements) {
    if (node.id) node.id = ids.get(node.id)!;
    // Visual copies must never participate in global citation/source lookup.
    for (const name of node.getAttributeNames()) {
      if (name.startsWith("data-assistant-citation-")) node.removeAttribute(name);
    }
    for (const attr of node.attributes) {
      let value = attr.value;
      for (const [id, replacement] of ids) {
        value = value.replaceAll(`url(#${id})`, `url(#${replacement})`);
        if (value === `#${id}`) value = `#${replacement}`;
      }
      if (value !== attr.value) node.setAttribute(attr.name, value);
    }
  }
  Object.assign(snapshot.style, {
    position: "absolute",
    inset: "0",
    zIndex: "2",
    pointerEvents: "none",
    animation: "none",
    opacity: String(opacity),
  });
  parent.append(snapshot);
  const originals = [viewport, ...viewport.querySelectorAll<HTMLElement>("*")];
  const copies = [snapshot, ...snapshot.querySelectorAll<HTMLElement>("*")];
  originals.forEach((source, index) => {
    if (source.scrollTop) copies[index]!.scrollTop = source.scrollTop;
    if (source.scrollLeft) copies[index]!.scrollLeft = source.scrollLeft;
  });
  const fade = () => {
    if (!pendingExits.has(snapshot)) return;
    pendingExits.delete(snapshot);
    window.clearTimeout(fallback);
    const animation = snapshot.animate([{ opacity }, { opacity: 0 }], {
      duration: 180,
      easing: "ease-in",
      fill: "forwards",
    });
    const remove = () => snapshot.remove();
    void animation.finished.then(remove, remove);
  };
  // Normal switches release when the next list is ready. Do not leave stale
  // conversation text indefinitely if a remote thread cannot finish loading.
  const fallback = window.setTimeout(fade, 800);
  pendingExits.set(snapshot, fade);
  queueMicrotask(() => {
    // Empty/draft views have no incoming list to signal readiness.
    if (
      !parent.hasAttribute("data-timeline-loading") &&
      !parent.querySelector("[data-assistant-citation-viewport]")
    )
      fade();
  });
}

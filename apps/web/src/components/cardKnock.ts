import { ACCOUNT_KNOCK_MS } from "./accountTransition.logic";

let knockSequence = 0;

/** A short-lived visual copy lets the card hit the divider without clipping its text.
 * The actual row stays mounted, preserving focus, drag state and React ownership. */
export function knockCard(
  row: HTMLElement,
  boundaryX: number,
): { cancel: () => void; startedAt: number } {
  const bounds = row.getBoundingClientRect();
  const ghost = row.cloneNode(true) as HTMLElement;
  const sources = [row, ...row.querySelectorAll<Element>("*")];
  const copies = [ghost, ...ghost.querySelectorAll<Element>("*")];
  const prefix = `lecturn-knock-${++knockSequence}-`;
  const ids = new Map(sources.filter((node) => node.id).map((node) => [node.id, prefix + node.id]));
  sources.forEach((source, index) => {
    const copy = copies[index] as HTMLElement | SVGElement;
    const computed = getComputedStyle(source);
    for (const property of computed)
      copy.style.setProperty(property, computed.getPropertyValue(property));
    copy.style.animation = "none";
    copy.style.transition = "none";
    copy.removeAttribute("autofocus");
    copy.removeAttribute("data-lecturn-thread-surface");
    if (copy.id) copy.id = ids.get(copy.id)!;
    for (const attr of copy.attributes) {
      let value = attr.value;
      for (const [id, replacement] of ids) {
        value = value.replaceAll(`url(#${id})`, `url(#${replacement})`);
        if (value === `#${id}`) value = `#${replacement}`;
      }
      if (value !== attr.value) copy.setAttribute(attr.name, value);
    }
  });
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("data-card-knock-ghost", "");
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    margin: "0",
    transform: "none",
    zIndex: "1000",
    pointerEvents: "none",
    visibility: "visible",
    contentVisibility: "visible",
    contain: "none",
    boxSizing: "border-box",
  });
  const previousOpacity = row.style.opacity;
  const tint = getComputedStyle(row).getPropertyValue("--account-tint").trim() || "#d5af63";
  ghost.style.outline = `1px solid color-mix(in srgb, ${tint} 65%, white)`;
  ghost.style.outlineOffset = "-1px";
  document.body.append(ghost);
  row.style.opacity = "0";
  const impact = Math.max(0, boundaryX - bounds.right);
  const duration = ACCOUNT_KNOCK_MS + 280;
  const animation = ghost.animate(
    [
      { transform: "translateX(0)", offset: 0, easing: "ease-out" },
      { transform: "translateX(-6px)", offset: 0.15, easing: "ease-in" },
      {
        transform: `translateX(${impact}px)`,
        offset: ACCOUNT_KNOCK_MS / duration,
        easing: "ease-out",
      },
      {
        transform: `translateX(${Math.max(0, impact - 5)}px)`,
        offset: 0.65,
        easing: "ease-in-out",
      },
      { transform: "translateX(0)", offset: 1 },
    ],
    { duration, easing: "linear", fill: "both" },
  );
  const startedAt = performance.now();
  animation.startTime = startedAt;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    animation.cancel();
    ghost.remove();
    row.style.opacity = previousOpacity;
  };
  void animation.finished.then(cleanup, cleanup);
  return { cancel: cleanup, startedAt };
}

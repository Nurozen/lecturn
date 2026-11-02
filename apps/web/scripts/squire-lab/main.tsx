// Standalone dev entry for the Squire lab, served by squire-b4-capture.ts through Vite's JS API
// so captures never need the Lecturn dev server or a router change.
import "~/index.css";

import { createRoot } from "react-dom/client";

import { parseSquireLabFixture, SquireLab } from "~/components/squire/companion/SquireLab";

const root = document.getElementById("root");
if (!import.meta.env.DEV) {
  throw new Error("The Squire lab is dev-only.");
}
if (root === null) throw new Error("#root is missing");
const search = new URLSearchParams(window.location.search);
if (search.get("theme") === "light") document.documentElement.classList.remove("dark");
// Transparent pages let captures keep alpha (the gold showcase stills).
if (search.get("bg") === "none") {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}
createRoot(root).render(<SquireLab fixture={parseSquireLabFixture(search)} />);

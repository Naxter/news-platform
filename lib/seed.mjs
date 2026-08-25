import { emptyStore } from "./config.mjs";

// A fresh install starts empty — no demo sources or articles. Add your own sources
// (RSS/Atom/news pages) or drop in a manual brief to begin gathering.
export function seedStore() {
  return emptyStore(new Date().toISOString());
}

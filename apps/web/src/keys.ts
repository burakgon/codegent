export function bindKeys(map: Record<string, () => void>): () => void {
  const h = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // never eat browser/system chords
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.closest("[data-term]")) return;
    const fn = map[e.key.toLowerCase()];
    if (fn) { e.preventDefault(); fn(); }
  };
  window.addEventListener("keydown", h);
  return () => window.removeEventListener("keydown", h);
}

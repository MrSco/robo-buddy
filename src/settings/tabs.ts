import { $ } from "./types";

export function showTab(name: string): void {
  const tabs = $<HTMLElement>("tabs");
  tabs.querySelector<HTMLButtonElement>(`button[data-tab="${name}"]`)?.click();
}

export function wireTabs(onTabChange?: (name: string) => void): void {
  const tabs = $<HTMLElement>("tabs");
  const buttons = Array.from(tabs.querySelectorAll<HTMLButtonElement>("button[data-tab]"));
  const pages = Array.from(document.querySelectorAll<HTMLElement>(".page[data-page]"));
  const live = $<HTMLCanvasElement>("live");

  const show = (name: string) => {
    for (const b of buttons) b.classList.toggle("active", b.dataset.tab === name);
    for (const p of pages) p.hidden = p.dataset.page !== name;

    onTabChange?.(name);

    // One WebGL preview, shown on the Character page, beside the animation list, or capture.
    const home = document.getElementById(
      name === "library" ? "preview-lib" : name === "capture" ? "preview-cap" : "preview-char"
    );
    const from = live.parentElement;
    if (home && from && from !== home) {
      // The canvas and, for a 2D character, its still image travel together.
      while (from.firstChild) home.appendChild(from.firstChild);
    }
    try {
      localStorage.setItem("settings-tab", name);
    } catch {
      /* no storage */
    }
  };

  for (const b of buttons) b.addEventListener("click", () => show(b.dataset.tab!));

  let initial = "character";
  try {
    initial = localStorage.getItem("settings-tab") ?? initial;
  } catch {
    /* no storage */
  }

  if (!pages.some((p) => p.dataset.page === initial)) initial = "character";
  show(initial);
}

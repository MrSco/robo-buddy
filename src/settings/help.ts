import { invoke } from "@tauri-apps/api/core";

export class HelpTab {
  private searchInput: HTMLInputElement | null = null;
  private chips: HTMLButtonElement[] = [];
  private cards: HTMLElement[] = [];
  private emptyEl: HTMLElement | null = null;
  private activeFilter = "all";

  init(): void {
    this.searchInput = document.getElementById("help-search") as HTMLInputElement | null;
    this.chips = Array.from(document.querySelectorAll<HTMLButtonElement>(".help-chip"));
    this.cards = Array.from(document.querySelectorAll<HTMLElement>(".help-card"));
    this.emptyEl = document.getElementById("help-empty");

    // Search filter
    this.searchInput?.addEventListener("input", () => this.applyFilters());

    // Category chips
    for (const chip of this.chips) {
      chip.addEventListener("click", () => {
        for (const c of this.chips) c.classList.remove("active");
        chip.classList.add("active");
        this.activeFilter = chip.dataset.filter ?? "all";
        this.applyFilters();
      });
    }

    // Action buttons
    const btnWeb = document.getElementById("help-open-web");
    btnWeb?.addEventListener("click", () => {
      this.openExternal("https://robobuddy.pages.dev/guide");
    });

    const btnAppData = document.getElementById("help-open-appdata");
    btnAppData?.addEventListener("click", () => {
      invoke("open_user_folder", { kind: "" }).catch((e) => {
        console.error("Failed to open app data folder:", e);
      });
    });

    const btnIssues = document.getElementById("help-open-issues");
    btnIssues?.addEventListener("click", () => {
      this.openExternal("https://github.com/MrSco/robo-buddy-releases/issues");
    });
  }

  private applyFilters(): void {
    const query = (this.searchInput?.value ?? "").trim().toLowerCase();
    let visibleCount = 0;

    for (const card of this.cards) {
      const category = card.dataset.category ?? "";
      const matchesCategory = this.activeFilter === "all" || category === this.activeFilter;
      const text = (card.textContent ?? "").toLowerCase();
      const matchesQuery = !query || text.includes(query);

      const visible = matchesCategory && matchesQuery;
      card.hidden = !visible;
      if (visible) visibleCount++;
    }

    if (this.emptyEl) {
      this.emptyEl.hidden = visibleCount > 0;
    }
  }

  private openExternal(url: string): void {
    invoke("open_url", { url }).catch(() => {
      window.open(url, "_blank");
    });
  }
}

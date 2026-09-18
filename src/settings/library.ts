import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { effectiveManifest, listLibrary, invalidateLibrary, ROLES, type LibraryClip } from "../library";
import type { PackRef, Manifest } from "../packs";
import { $, type SettingsContext, type TabModule } from "./types";

export class LibraryTab implements TabModule {
  private ctx!: SettingsContext;
  private els = {
    libsearch: $<HTMLInputElement>("libsearch"),
    libsource: $<HTMLSelectElement>("libsource"),
    library: $<HTMLDivElement>("library"),
    openClips: $<HTMLButtonElement>("open-clips"),
  };
  private playButtons = new Map<string, HTMLButtonElement>();
  private libraryClips: LibraryClip[] = [];

  init(ctx: SettingsContext): void {
    this.ctx = ctx;

    this.els.libsearch.addEventListener("input", () => void this.renderLibrary());
    this.els.libsource.addEventListener("change", () => void this.renderLibrary());
    this.els.openClips.addEventListener("click", () => void invoke("open_user_folder", { kind: "clips" }).catch(() => {}));

    ctx.getLive().onPreviewChange = (name) => {
      for (const [clip, btn] of this.playButtons) {
        btn.textContent = clip === name ? "■" : "▶";
        btn.closest(".clip")?.classList.toggle("previewing", clip === name);
      }
    };
  }

  render(): void {
    void this.renderLibrary();
  }

  async renderLibrary(): Promise<void> {
    const packs = this.ctx.getPacks();
    const ref = packs.find((p) => p.id === "rocco");
    const refManifest = ref ? await this.ctx.getManifest(ref) : undefined;
    this.libraryClips = await listLibrary(refManifest);
    const q = this.els.libsearch.value.trim().toLowerCase();
    const src = this.els.libsource.value;
    const settings = this.ctx.getSettings();
    this.els.library.innerHTML = "";

    for (const c of this.libraryClips) {
      if (src && c.source !== src) continue;
      if (q && !c.name.toLowerCase().includes(q)) continue;
      const name = document.createElement("div");
      name.className = "name";
      name.title = c.name;
      name.textContent = c.name.replace(/_/g, " ");
      const tag = document.createElement("span");
      tag.className = "src";
      tag.textContent = c.source === "user" ? "mine" : c.source;
      name.appendChild(tag);
      const role = document.createElement("select");
      for (const r of ROLES) {
        const o = document.createElement("option");
        o.value = r;
        o.textContent = r === "off" ? "not used" : r;
        role.appendChild(o);
      }
      role.value = settings.animRoles?.[c.name] ?? c.defaultRole;
      role.addEventListener("change", () => {
        const roles = { ...(this.ctx.getSettings().animRoles ?? {}) };
        if (role.value === c.defaultRole) delete roles[c.name];
        else roles[c.name] = role.value;
        void this.ctx.commit({ animRoles: roles });
      });
      const play = document.createElement("button");
      play.type = "button";
      play.textContent = "▶";
      play.title = "Preview on the selected character (click again to stop)";
      play.addEventListener("click", () =>
        void this.ctx
          .getLive()
          .playClip(c.name, c.url)
          .catch((err) => this.ctx.status(`Preview failed: ${err}`))
      );
      this.playButtons.set(c.name, play);
      const card = document.createElement("div");
      card.className = "clip";
      card.dataset.clip = c.name;
      card.append(name, role, play);
      if (c.source === "user" && c.file) {
        card.classList.add("mine");
        const del = document.createElement("button");
        del.type = "button";
        del.className = "del";
        del.textContent = "🗑";
        del.title = "Delete this clip from your library";
        del.addEventListener("click", async () => {
          const sure = await ask(`Delete the clip "${c.name}"? This removes the file.`, {
            title: "Delete clip",
            kind: "warning",
            okLabel: "Delete",
            cancelLabel: "Keep",
          });
          if (!sure) return;
          try {
            if (this.ctx.getLive().previewing === c.name) this.ctx.getLive().stopPreview();
            await invoke("delete_user_clip", { file: c.file });
            const roles = { ...(this.ctx.getSettings().animRoles ?? {}) };
            delete roles[c.name];
            invalidateLibrary();
            await this.ctx.commit({ animRoles: roles });
            await this.renderLibrary();
            this.ctx.status(`Deleted "${c.name}".`);
          } catch (err) {
            this.ctx.status(`Could not delete: ${err}`);
          }
        });
        card.appendChild(del);
      }
      this.els.library.appendChild(card);
    }
  }

  async runningManifestFor(pack: PackRef): Promise<Manifest> {
    const base = await this.ctx.getManifest(pack);
    if (base.renderer !== "3d") return base;
    const ref = this.ctx.getPacks().find((p) => p.id === "rocco");
    const reference = ref ? await this.ctx.getManifest(ref) : undefined;
    return effectiveManifest(
      base,
      pack.bundled,
      reference,
      await listLibrary(reference),
      this.ctx.getSettings().animRoles ?? {}
    );
  }
}

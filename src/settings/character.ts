import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { thumbnailFor } from "../preview";
import { $, type SettingsContext, type TabModule } from "./types";
import type { Settings } from "../settings-store";

export class CharacterTab implements TabModule {
  private ctx!: SettingsContext;
  private els = {
    character: $<HTMLSelectElement>("character"),
    import: $<HTMLButtonElement>("import"),
    removePack: $<HTMLButtonElement>("remove-pack"),
    openCharacters: $<HTMLButtonElement>("open-characters"),
    bring: $<HTMLButtonElement>("bring"),
    size: $<HTMLInputElement>("size"),
    sizeOut: $<HTMLOutputElement>("size-out"),
    lighting: $<HTMLInputElement>("lighting"),
    lightOut: $<HTMLOutputElement>("light-out"),
    gallery: $<HTMLDivElement>("gallery"),
  };

  init(ctx: SettingsContext): void {
    this.ctx = ctx;

    this.els.character.addEventListener("change", () => ctx.commit({ character: this.els.character.value }));

    this.els.size.addEventListener("input", () => {
      this.els.sizeOut.value = `${Math.round(Number(this.els.size.value) * 100)}%`;
    });
    this.els.size.addEventListener("change", () => ctx.commit({ size: Number(this.els.size.value) }));

    this.els.lighting.addEventListener("input", () => {
      this.els.lightOut.value = `${Math.round(Number(this.els.lighting.value) * 100)}%`;
      ctx.getLive().lighting = Number(this.els.lighting.value);
    });
    this.els.lighting.addEventListener("change", () => {
      const id = ctx.getPreviewing() ?? ctx.getSettings().character;
      const settings = ctx.getSettings();
      void ctx.commit({ lightingByCharacter: { ...(settings.lightingByCharacter ?? {}), [id]: Number(this.els.lighting.value) } });
    });

    this.els.openCharacters.addEventListener("click", () => void invoke("open_user_folder", { kind: "characters" }).catch(() => {}));

    this.els.removePack.addEventListener("click", async () => {
      const pack = ctx.getPacks().find((p) => p.id === ctx.getPreviewing());
      if (!pack || pack.bundled) return;
      if (!confirm(`Remove "${pack.name}"? Its files are deleted from your characters folder.`)) return;
      try {
        await invoke("delete_user_pack", { id: pack.id });
        if (ctx.getSettings().character === pack.id) await ctx.commit({ character: "rocco" });
        this.els.removePack.hidden = true;
        await ctx.refreshPacks();
        await ctx.updatePackDetails();
        ctx.status(`Removed "${pack.name}".`);
      } catch (err) {
        ctx.status(`Could not remove: ${err}`);
      }
    });

    this.els.bring.addEventListener("click", () => invoke("bring_here").catch((err) => ctx.status(`Could not move him: ${err}`)));

    this.els.import.addEventListener("click", async () => {
      const file = await open({
        multiple: false,
        directory: false,
        title: "Choose a character model",
        filters: [
          { name: "3D models", extensions: ["glb", "vrm", "gltf", "fbx"] },
          { name: "Animated images", extensions: ["webp", "gif", "png", "apng"] },
        ],
      });
      if (!file) return;
      try {
        const pack = await invoke<{ id: string; name: string }>("import_pack", { source: file, name: null });
        await ctx.refreshPacks();
        await ctx.commit({ character: pack.id });
        this.els.character.value = pack.id;
        ctx.status(`Imported "${pack.name}".`);
      } catch (err) {
        ctx.status(`Import failed: ${err}`);
      }
    });
  }

  render(settings: Settings): void {
    this.els.character.value = settings.character;
    this.els.size.value = String(settings.size);
    this.els.sizeOut.value = `${Math.round(settings.size * 100)}%`;
    this.ctx.showLightingFor(this.ctx.getPreviewing() ?? settings.character);
  }

  async renderGallery(): Promise<void> {
    const ticket = this.ctx.getLive().beginLoading();
    this.els.gallery.innerHTML = "";
    const packs = this.ctx.getPacks();
    const settings = this.ctx.getSettings();

    for (const p of packs) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.id = p.id;
      b.title = p.name;
      b.classList.toggle("selected", p.id === settings.character);
      const label = document.createElement("span");
      label.textContent = p.name;
      b.appendChild(label);
      b.addEventListener("click", () => {
        if (this.ctx.getPreviewing() === p.id && settings.character !== p.id) {
          void this.ctx.commit({ character: p.id });
          for (const x of this.els.gallery.querySelectorAll("button")) x.classList.toggle("selected", x.dataset.id === p.id);
          void this.ctx.updatePackDetails();
        } else void this.ctx.previewPack(p.id);
      });
      this.els.gallery.appendChild(b);
    }

    for (const p of packs) {
      try {
        const m = await this.ctx.getManifest(p);
        const src = await thumbnailFor(p, m, this.ctx.getLive());
        const b = this.els.gallery.querySelector<HTMLButtonElement>(`button[data-id="${CSS.escape(p.id)}"]`);
        if (b) b.style.backgroundImage = `url(${src})`;
      } catch {
        // leave placeholder
      }
    }

    try {
      if (this.ctx.getPreviewing() === null) await this.ctx.previewPack(settings.character);
    } finally {
      this.ctx.getLive().finishLoading(ticket);
    }
  }

  refreshPackSelect(): void {
    const packs = this.ctx.getPacks();
    this.els.character.innerHTML = "";
    for (const p of packs) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.bundled ? p.name : `${p.name} (imported)`;
      this.els.character.appendChild(opt);
    }
    this.els.character.value = this.ctx.getSettings().character;
    void this.renderGallery();
  }
}

import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { invalidateThumbnail, thumbnailFor } from "../preview";
import { $, type SettingsContext, type TabModule } from "./types";
import type { Settings } from "../settings-store";

export class CharacterTab implements TabModule {
  private ctx!: SettingsContext;
  private els = {
    character: $<HTMLSelectElement>("character"),
    selectBuddy: $<HTMLButtonElement>("select-buddy"),
    import: $<HTMLButtonElement>("import"),
    rigStudio: $<HTMLButtonElement>("rig-studio"),
    removePack: $<HTMLButtonElement>("remove-pack"),
    openCharacters: $<HTMLButtonElement>("open-characters"),
    bring: $<HTMLButtonElement>("bring"),
    size: $<HTMLInputElement>("size"),
    sizeOut: $<HTMLOutputElement>("size-out"),
    lighting: $<HTMLInputElement>("lighting"),
    lightOut: $<HTMLOutputElement>("light-out"),
    gallery: $<HTMLDivElement>("gallery"),
  };

  updateSelectBuddyButton(): void {
    const previewId = this.ctx.getPreviewing() ?? this.ctx.getSettings().character;
    const activeId = this.ctx.getSettings().character;
    const pack = this.ctx.getPacks().find((p) => p.id === previewId);
    if (!this.els.selectBuddy) return;
    if (!pack || previewId === activeId) {
      this.els.selectBuddy.hidden = true;
    } else {
      this.els.selectBuddy.hidden = false;
      this.els.selectBuddy.textContent = `Set "${pack.name}" as Buddy`;
    }
  }

  async selectCharacter(id: string): Promise<void> {
    const pack = this.ctx.getPacks().find((p) => p.id === id);
    if (!pack) return;
    await this.ctx.commit({ character: id });
    this.els.character.value = id;
    for (const b of this.els.gallery.querySelectorAll("button")) {
      b.classList.toggle("selected", b.dataset.id === id);
    }
    await this.ctx.updatePackDetails();
    this.updateSelectBuddyButton();
    this.ctx.status(`Selected "${pack.name}" as active buddy.`);
  }

  init(ctx: SettingsContext): void {
    this.ctx = ctx;

    this.els.character.addEventListener("change", async () => {
      const id = this.els.character.value;
      await this.selectCharacter(id);
      await this.ctx.previewPack(id);
    });

    this.els.selectBuddy?.addEventListener("click", async () => {
      const targetId = ctx.getPreviewing() ?? ctx.getSettings().character;
      await this.selectCharacter(targetId);
    });

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
      const sure = await ask(`Remove "${pack.name}"? Its files are deleted from your characters folder.`, {
        title: "Remove character",
        kind: "warning",
        okLabel: "Remove",
        cancelLabel: "Keep",
      });
      if (!sure) return;
      try {
        await invoke("delete_user_pack", { id: pack.id });
        const fallback = ctx.getSettings().character === pack.id ? "rocco" : ctx.getSettings().character;
        if (ctx.getSettings().character === pack.id) await ctx.commit({ character: "rocco" });
        this.els.removePack.hidden = true;
        this.els.rigStudio.hidden = true;
        await ctx.refreshPacks();
        await ctx.updatePackDetails();
        await ctx.previewPack(fallback);
        ctx.status(`Removed "${pack.name}".`);
      } catch (err) {
        ctx.status(`Could not remove: ${err}`);
      }
    });

    this.els.rigStudio.addEventListener("click", async () => {
      const packId = ctx.getPreviewing() ?? ctx.getSettings().character;
      const pack = ctx.getPacks().find((p) => p.id === packId);
      if (!pack || pack.bundled) return;
      try {
        const m = await ctx.getManifest(pack, true);
        if (m.renderer !== "3d") return;
        ctx.status(`Loading "${pack.name}" into Skeleton Studio...`);
        const { loadModel, restoreBindPose } = await import("../character");
        const probe = await loadModel(pack.base + m.model);
        restoreBindPose(probe.root);
        const { showRigDialog } = await import("./rig-dialog");
        const { inferRigParamsFromSkeleton } = await import("../autorig");
        const initialParams = m.rigParams ?? inferRigParamsFromSkeleton(probe.root) ?? undefined;
        const res = await showRigDialog({ modelName: pack.name, root: probe.root, params: initialParams });
        if (res.action === "rig") {
          ctx.status(`Auto-rigging "${pack.name}" skeleton...`);
          const { autoRig } = await import("../autorig");
          const riggedGlb = await autoRig(probe.root, res.params);
          const targetPath = `${pack.dir}\\${m.model}`;
          await invoke("save_pack_glb", new Uint8Array(riggedGlb), {
            headers: { "x-pack-model-path": targetPath },
          });
          await invoke("set_pack_rig_params", { id: pack.id, params: res.params });
          invalidateThumbnail(pack.id);
          await ctx.refreshPacks();
          if (ctx.getSettings().character === pack.id) {
            await ctx.commit({ character: pack.id, characterRevision: Date.now() });
          }
          ctx.status(`Updated skeleton for "${pack.name}".`);
          await ctx.previewPack(pack.id);
          this.updateSelectBuddyButton();
        }
      } catch (err) {
        ctx.status(`Failed to update skeleton: ${err}`);
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
        const ext = file.split(".").pop()?.toLowerCase() ?? "";
        const staged = await invoke<string>("stage_dropped", { source: file });
        let importedRigParams: any = null;
        if (["glb", "gltf", "fbx"].includes(ext)) {
          const { loadModel } = await import("../character");
          const { convertFileSrc } = await import("@tauri-apps/api/core");
          const probe = await loadModel(convertFileSrc(staged));
          const { isModelRigged, hasMeshGeometry, autoRig } = await import("../autorig");
          if (hasMeshGeometry(probe.root) && !isModelRigged(probe.root)) {
            const { showRigDialog } = await import("./rig-dialog");
            const fileName = file.split(/[/\\]/).pop() ?? "model";
            const res = await showRigDialog({ modelName: fileName, root: probe.root });
            if (res.action === "cancel") return;
            if (res.action === "rig") {
              ctx.status("Auto-rigging skeleton...");
              importedRigParams = res.params;
              const riggedGlb = await autoRig(probe.root, res.params);
              await invoke("save_staged_glb", new Uint8Array(riggedGlb), {
                headers: { "x-staged-path": staged },
              });
            }
          }
        }
        const pack = await invoke<{ id: string; name: string }>("finalize_import", { staged, kind: "model", name: null });
        if (importedRigParams) {
          await invoke("set_pack_rig_params", { id: pack.id, params: importedRigParams });
        }
        await ctx.refreshPacks();
        await ctx.commit({ character: pack.id });
        this.els.character.value = pack.id;
        await ctx.previewPack(pack.id);
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
    for (const b of this.els.gallery.querySelectorAll("button")) {
      b.classList.toggle("selected", b.dataset.id === settings.character);
    }
    this.updateSelectBuddyButton();
  }

  async renderGallery(): Promise<void> {
    const ticket = this.ctx.getLive().beginLoading();
    this.els.gallery.innerHTML = "";
    const packs = this.ctx.getPacks();
    const active = this.ctx.getSettings().character;

    for (const p of packs) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.id = p.id;
      b.title = p.name;
      b.classList.toggle("selected", p.id === active);
      const label = document.createElement("span");
      label.textContent = p.name;
      b.appendChild(label);
      b.addEventListener("click", async () => {
        const currentActive = this.ctx.getSettings().character;
        if (this.ctx.getPreviewing() === p.id && currentActive !== p.id) {
          await this.selectCharacter(p.id);
        } else {
          await this.ctx.previewPack(p.id);
          this.updateSelectBuddyButton();
        }
      });
      b.addEventListener("dblclick", async () => {
        await this.selectCharacter(p.id);
        await this.ctx.previewPack(p.id);
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
      if (this.ctx.getPreviewing() === null) await this.ctx.previewPack(active);
    } finally {
      this.ctx.getLive().finishLoading(ticket);
      this.updateSelectBuddyButton();
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

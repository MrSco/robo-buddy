import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isEnabled } from "@tauri-apps/plugin-autostart";
import { LivePreview } from "../preview";
import { listPacks, type Manifest, type PackRef } from "../packs";
import {
  DEFAULT_SETTINGS,
  getSettings,
  lightingFor,
  onSettingsChanged,
  setSettings,
  type Settings,
} from "../settings-store";
import { invalidateLibrary } from "../library";
import { $, type SettingsContext } from "./types";
import { wireTabs } from "./tabs";
import { CharacterTab } from "./character";
import { ReactionsTab } from "./reactions";
import { TalkTab } from "./talk";
import { LibraryTab } from "./library";
import { CaptureTab } from "./capture";
import { WindowTab } from "./window";
import { HelpTab } from "./help";

export class SettingsApp implements SettingsContext {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private applying = false;
  private packs: PackRef[] = [];
  private manifests = new Map<string, Manifest>();
  private live: LivePreview | null = null;
  private previewing: string | null = null;
  private previewSelection = 0;
  private currentManifest: Manifest | null = null;

  private statusEl = $<HTMLParagraphElement>("status");
  private dropzoneEl = $<HTMLDivElement>("dropzone");

  public characterTab = new CharacterTab();
  public reactionsTab = new ReactionsTab();
  public talkTab = new TalkTab();
  public libraryTab = new LibraryTab();
  public captureTab = new CaptureTab();
  public windowTab = new WindowTab();
  public helpTab = new HelpTab();

  getSettings(): Settings {
    return this.settings;
  }

  async commit(patch: Partial<Settings>): Promise<void> {
    if (this.applying) return;
    this.settings = { ...this.settings, ...patch };
    await setSettings(this.settings);
  }

  getLive(): LivePreview {
    if (!this.live) {
      const canvas = $<HTMLCanvasElement>("live");
      this.live = new LivePreview(canvas);
    }
    return this.live;
  }

  getPacks(): PackRef[] {
    return this.packs;
  }

  async getManifest(pack: PackRef): Promise<Manifest> {
    let m = this.manifests.get(pack.id);
    if (!m) {
      m = (await (await fetch(pack.base + "manifest.json")).json()) as Manifest;
      this.manifests.set(pack.id, m);
    }
    return m;
  }

  async getRunningManifest(pack: PackRef): Promise<Manifest> {
    return this.libraryTab.runningManifestFor(pack);
  }

  getCurrentManifest(): Manifest | null {
    return this.currentManifest;
  }

  getPreviewing(): string | null {
    return this.previewing;
  }

  setPreviewing(id: string | null): void {
    this.previewing = id;
  }

  status(msg: string): void {
    this.statusEl.textContent = msg;
    if (msg) setTimeout(() => (this.statusEl.textContent === msg ? (this.statusEl.textContent = "") : null), 4000);
  }

  showLightingFor(character: string): void {
    const v = lightingFor(this.settings, character);
    const lighting = $<HTMLInputElement>("lighting");
    const lightOut = $<HTMLOutputElement>("light-out");
    lighting.value = String(v);
    lightOut.value = `${Math.round(v * 100)}%`;
    if (this.live) this.live.lighting = v;
  }

  async previewPack(id: string): Promise<void> {
    const selection = ++this.previewSelection;
    const pack = this.packs.find((p) => p.id === id);
    if (!pack) return;
    this.previewing = id;
    this.showLightingFor(id);
    const gallery = $<HTMLDivElement>("gallery");
    for (const b of gallery.querySelectorAll("button")) b.classList.toggle("previewing", b.dataset.id === id);
    const removePack = $<HTMLButtonElement>("remove-pack");
    removePack.hidden = pack.bundled;
    removePack.textContent = `Remove "${pack.name}"`;
    const ticket = this.getLive().beginLoading();
    let failure: unknown;
    try {
      const m = await this.getManifest(pack);
      if (selection !== this.previewSelection) return;
      await this.getLive().show(pack, m);
      if (selection === this.previewSelection && m.renderer === "3d") this.status(`Rig: ${this.getLive().rigReport}`);
    } catch (err) {
      failure = err;
      if (selection === this.previewSelection) this.status(`Preview failed: ${err}`);
    } finally {
      this.getLive().finishLoading(ticket, failure);
    }
  }

  async refreshPacks(): Promise<void> {
    this.packs = await listPacks();
    this.characterTab.refreshPackSelect();
  }

  async updatePackDetails(): Promise<void> {
    const pack = this.packs.find((p) => p.id === this.settings.character) ?? this.packs[0];
    if (!pack) return;
    const m = await this.getRunningManifest(pack);
    this.currentManifest = m;
    this.reactionsTab.renderDanceChoices(m);
    this.reactionsTab.renderIdleSet(m);
  }

  async renderLibrary(): Promise<void> {
    await this.libraryTab.renderLibrary();
  }

  async importFile(path: string): Promise<void> {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    try {
      this.status(`Importing ${path.split(/[\\/]/).pop()}…`);
      const staged = await invoke<string>("stage_dropped", { source: path });
      let kind: "model" | "clip" = "model";
      if (["glb", "gltf", "fbx"].includes(ext)) {
        const { loadModel } = await import("../character");
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const probe = await loadModel(convertFileSrc(staged));
        let hasMesh = false;
        probe.root.traverse((o) => {
          if ((o as { isMesh?: boolean }).isMesh) hasMesh = true;
        });
        kind = hasMesh ? "model" : probe.animations.length ? "clip" : "model";
      } else if (!["webp", "gif", "png", "apng", "vrm"].includes(ext)) {
        this.status(`Unsupported file type .${ext}`);
        return;
      }
      const result = await invoke<{ kind: string; id?: string; name: string }>("finalize_import", {
        staged,
        kind,
        name: null,
      });
      invalidateLibrary();
      if (result.kind === "model" && result.id) {
        await this.refreshPacks();
        await this.commit({ character: result.id });
        this.status(`Imported "${result.name}".`);
      } else {
        await this.renderLibrary();
        this.status(`Added animation "${result.name}". Pick a role for it below.`);
      }
    } catch (err) {
      this.status(`Import failed: ${err}`);
    }
  }

  render(): void {
    this.applying = true;
    this.characterTab.render(this.settings);
    this.reactionsTab.render(this.settings);
    this.talkTab.render(this.settings);
    this.windowTab.render(this.settings);
    this.applying = false;
    void this.updatePackDetails();
    void this.renderLibrary();
  }

  async start(): Promise<void> {
    // 1. Always load settings first before initializing any tab
    this.settings = await getSettings();
    try {
      this.settings.autostart = await isEnabled();
    } catch {
      // not in Tauri
    }

    // 2. Wire tabs and switch hook
    wireTabs((name) => {
      if (name === "talk" && this.settings.ttsEngine === "piper") {
        void this.talkTab.refreshPiper();
      }
    });

    // 3. Initialize all tab event listeners
    this.characterTab.init(this);
    this.reactionsTab.init(this);
    this.talkTab.init(this);
    this.libraryTab.init(this);
    this.captureTab.init(this);
    this.windowTab.init(this);
    this.helpTab.init();

    // 4. Populate packs and initial render
    await this.refreshPacks();
    this.render();

    // 5. Post-initialization async data
    void this.talkTab.postInit();
    void this.windowTab.postInit();

    // 6. External drag and drop handling
    try {
      await getCurrentWebview().onDragDropEvent(async (e) => {
        this.dropzoneEl.classList.toggle("over", e.payload.type === "enter" || e.payload.type === "over");
        if (e.payload.type !== "drop") return;
        for (const path of e.payload.paths) await this.importFile(path);
      });
    } catch {
      // not in Tauri
    }

    // 7. Window focus listener to refresh packs from disk
    window.addEventListener("focus", () => this.refreshPacks().catch(() => {}));

    // 8. Reactive sync when settings change from tray or buddy window
    await onSettingsChanged((s) => {
      this.settings = s;
      this.render();
    });
  }
}

export async function main(): Promise<SettingsApp> {
  const app = new SettingsApp();
  await app.start();
  return app;
}

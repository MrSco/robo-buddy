import type { Settings } from "../settings-store";
import type { PackRef, Manifest } from "../packs";
import type { LivePreview } from "../preview";

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface SettingsContext {
  getSettings(): Settings;
  commit(patch: Partial<Settings>): Promise<void>;
  getLive(): LivePreview;
  getPacks(): PackRef[];
  getManifest(pack: PackRef): Promise<Manifest>;
  getRunningManifest(pack: PackRef): Promise<Manifest>;
  getCurrentManifest(): Manifest | null;
  getPreviewing(): string | null;
  setPreviewing(id: string | null): void;
  status(msg: string): void;
  refreshPacks(): Promise<void>;
  updatePackDetails(): Promise<void>;
  renderLibrary(): Promise<void>;
  importFile(path: string): Promise<void>;
  showLightingFor(id: string): void;
  previewPack(id: string): Promise<void>;
}

export interface TabModule {
  init(ctx: SettingsContext): void | Promise<void>;
  render?(settings: Settings): void;
}

import type { Settings } from "../settings-store";
import type { LivePreview } from "../preview";
import type { Manifest, PackRef } from "../packs";

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface SettingsContext {
  getSettings(): Settings;
  commit(patch: Partial<Settings>): Promise<void>;
  getLive(): LivePreview;
  getPacks(): PackRef[];
  getManifest(pack: PackRef, forceReload?: boolean): Promise<Manifest>;
  getRunningManifest(pack: PackRef): Promise<Manifest>;
  getCurrentManifest(): Manifest | null;
  getPreviewing(): string | null;
  setPreviewing(id: string | null): void;
  status(msg: string): void;
  showLightingFor(character: string): void;
  previewPack(id: string): Promise<void>;
  refreshPacks(): Promise<void>;
  updatePackDetails(): Promise<void>;
  renderLibrary(): Promise<void>;
}

export interface TabModule {
  init(ctx: SettingsContext): void;
  render(settings: Settings): void;
  postInit?(): Promise<void>;
}

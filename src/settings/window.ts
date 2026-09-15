import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { enable, disable } from "@tauri-apps/plugin-autostart";
import type { ClickThroughMode, Settings } from "../settings-store";
import { $, type SettingsContext, type TabModule } from "./types";

declare const __BUILD__: string;

export class WindowTab implements TabModule {
  private ctx!: SettingsContext;
  private els = {
    fullscreen: $<HTMLInputElement>("fullscreen"),
    taskbar: $<HTMLInputElement>("taskbar"),
    clickthrough: $<HTMLSelectElement>("clickthrough"),
    autostart: $<HTMLInputElement>("autostart"),
    tabVersion: $<HTMLParagraphElement>("tab-version"),
    ssSpeed: $<HTMLInputElement>("ss-speed"),
    ssSpeedOut: $<HTMLOutputElement>("ss-speed-out"),
    ssVoid: $<HTMLInputElement>("ss-void"),
    ssErosionStyle: $<HTMLSelectElement>("ss-erosion-style"),
    ssSounds: $<HTMLInputElement>("ss-sounds"),
    ssBackdrop: $<HTMLInputElement>("ss-backdrop"),
    ssBrowse: $<HTMLButtonElement>("ss-browse"),
    ssClear: $<HTMLButtonElement>("ss-clear"),
    ssBackdropStatus: $<HTMLParagraphElement>("ss-backdrop-status"),
    ssAfter: $<HTMLInputElement>("ss-after"),
    ssBackdropMode: $<HTMLSelectElement>("ss-backdrop-mode"),
    ssCustomBackdrop: $<HTMLDivElement>("ss-custom-backdrop"),
    ssWinStatus: $<HTMLParagraphElement>("ss-win-status"),
  };

  init(ctx: SettingsContext): void {
    this.ctx = ctx;

    this.els.fullscreen.addEventListener("change", () =>
      ctx.commit({ hideWhenFullscreen: this.els.fullscreen.checked })
    );
    this.els.taskbar.addEventListener("change", () =>
      ctx.commit({ standOnTaskbar: this.els.taskbar.checked })
    );
    this.els.clickthrough.addEventListener("change", () =>
      ctx.commit({ clickThrough: this.els.clickthrough.value as ClickThroughMode })
    );

    this.els.autostart.addEventListener("change", async () => {
      try {
        if (this.els.autostart.checked) await enable();
        else await disable();
        await ctx.commit({ autostart: this.els.autostart.checked });
        ctx.status(this.els.autostart.checked ? "Robo Buddy will start with Windows." : "Autostart disabled.");
      } catch (err) {
        ctx.status(`Could not change autostart: ${err}`);
        this.els.autostart.checked = !this.els.autostart.checked;
      }
    });

    this.wireScreensaver();
    void this.showVersion();
  }

  async postInit(): Promise<void> {
    await this.refreshWindowsSaver();
  }

  render(settings: Settings): void {
    this.els.fullscreen.checked = settings.hideWhenFullscreen;
    this.els.taskbar.checked = settings.standOnTaskbar;
    this.els.clickthrough.value = settings.clickThrough;
    this.els.autostart.checked = settings.autostart;

    this.els.ssSpeed.value = String(settings.screensaverErosionSpeed ?? 20);
    this.els.ssSpeedOut.value = `${this.els.ssSpeed.value}%`;
    this.els.ssVoid.value = String(settings.screensaverVoidSeconds ?? 6);
    this.els.ssErosionStyle.value = settings.screensaverErosionStyle ?? "cracks";
    this.els.ssSounds.checked = settings.screensaverSounds ?? false;
    this.els.ssBackdrop.value = settings.screensaverBackdrop ?? "";
    this.els.ssAfter.value = String(settings.screensaverAfterMin ?? 0);
    this.els.ssBackdropMode.value =
      settings.screensaverBackdropMode || (settings.screensaverBackdrop ? "custom" : "windows");
    this.els.ssCustomBackdrop.hidden = this.els.ssBackdropMode.value !== "custom";
    void this.refreshWindowsSaver();
  }

  private wireScreensaver(): void {
    this.els.ssSpeed.addEventListener("input", () => {
      this.els.ssSpeedOut.value = `${this.els.ssSpeed.value}%`;
    });
    this.els.ssSpeed.addEventListener("change", () =>
      void this.ctx.commit({ screensaverErosionSpeed: Number(this.els.ssSpeed.value) })
    );
    this.els.ssVoid.addEventListener("change", () =>
      void this.ctx.commit({ screensaverVoidSeconds: Math.max(0, Math.min(120, Number(this.els.ssVoid.value) || 0)) })
    );
    this.els.ssErosionStyle.addEventListener("change", () =>
      void this.ctx.commit({ screensaverErosionStyle: this.els.ssErosionStyle.value === "cracks" ? "cracks" : "tiles" })
    );
    this.els.ssSounds.addEventListener("change", () =>
      void this.ctx.commit({ screensaverSounds: this.els.ssSounds.checked })
    );
    this.els.ssBackdrop.addEventListener("change", () => void this.setBackdrop(this.els.ssBackdrop.value.trim()));
    this.els.ssClear.addEventListener("click", () => {
      this.els.ssBackdrop.value = "";
      void this.setBackdrop("");
    });
    this.els.ssBrowse.addEventListener("click", async () => {
      try {
        const picked = await open({
          multiple: false,
          filters: [{ name: "Screensaver", extensions: ["scr", "exe"] }],
        });
        if (typeof picked === "string") {
          this.els.ssBackdrop.value = picked;
          await this.setBackdrop(picked);
        }
      } catch (err) {
        this.els.ssBackdropStatus.textContent = `Could not open that: ${err}`;
      }
    });
    this.els.ssAfter.addEventListener("change", async () => {
      try {
        this.els.ssWinStatus.textContent = await invoke<string>("set_idle_screensaver", {
          minutes: Number(this.els.ssAfter.value),
        });
      } catch (err) {
        this.els.ssAfter.value = String(this.ctx.getSettings().screensaverAfterMin ?? 0);
        this.els.ssWinStatus.textContent = String(err);
      }
    });
    this.els.ssBackdropMode.addEventListener("change", () => {
      const mode = this.els.ssBackdropMode.value as "windows" | "custom" | "none";
      this.els.ssCustomBackdrop.hidden = mode !== "custom";
      void this.ctx.commit({ screensaverBackdropMode: mode });
      this.els.ssBackdropStatus.textContent =
        mode === "windows"
          ? "Uses your current Windows screensaver selection automatically."
          : mode === "none"
            ? "Plain black behind the desktop effects."
            : "Choose a screensaver to play behind Buddy.";
    });
  }

  async setBackdrop(path: string): Promise<void> {
    await this.ctx.commit({ screensaverBackdrop: path, screensaverBackdropMode: "custom" });
    this.els.ssBackdropStatus.textContent = path
      ? "It will play behind the screensaver; knock a window aside to see it."
      : "Plain black behind the screensaver.";
  }

  async refreshWindowsSaver(): Promise<void> {
    try {
      this.els.ssWinStatus.textContent = await invoke<string>("idle_saver_status");
    } catch {
      this.els.ssWinStatus.textContent = "";
    }
  }

  async showVersion(): Promise<void> {
    let version = "";
    try {
      version = await getVersion();
    } catch {
      // not in Tauri
    }
    this.els.tabVersion.textContent = "";
    for (const part of [version && `v${version}`, typeof __BUILD__ !== "undefined" ? __BUILD__ : ""].filter(Boolean)) {
      const line = document.createElement("span");
      line.textContent = part as string;
      this.els.tabVersion.append(line);
    }
  }
}

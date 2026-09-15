import { invoke } from "@tauri-apps/api/core";
import { emit, listen as listenEvent } from "@tauri-apps/api/event";
import { Capture } from "../capture";
import { PoseRecorder, exportClipGlb } from "../mocap";
import { canonicalRig } from "../retarget";
import { invalidateLibrary } from "../library";
import { $, type SettingsContext, type TabModule } from "./types";
import { showTab } from "./tabs";

export class CaptureTab implements TabModule {
  private ctx!: SettingsContext;
  private capture: Capture | null = null;
  private recorder = new PoseRecorder();
  private recording = false;
  private lastRecorded: { seconds: number } | null = null;
  private poseSeq = 0;

  private els = {
    tabs: $<HTMLElement>("tabs"),
    cam: $<HTMLVideoElement>("cam"),
    camOverlay: $<HTMLCanvasElement>("cam-overlay"),
    camEmpty: $<HTMLDivElement>("cam-empty"),
    camStart: $<HTMLButtonElement>("cam-start"),
    camMirror: $<HTMLInputElement>("cam-mirror"),
    camHands: $<HTMLInputElement>("cam-hands"),
    camStatus: $<HTMLSpanElement>("cam-status"),
    camRecord: $<HTMLButtonElement>("cam-record"),
    camRecStatus: $<HTMLSpanElement>("cam-rec-status"),
    camName: $<HTMLInputElement>("cam-name"),
    camRole: $<HTMLSelectElement>("cam-role"),
    camLoop: $<HTMLInputElement>("cam-loop"),
    camSave: $<HTMLButtonElement>("cam-save"),
    camSaveStatus: $<HTMLParagraphElement>("cam-save-status"),
  };

  init(ctx: SettingsContext) {
    this.ctx = ctx;

    this.els.camStart.addEventListener("click", () => (this.capture?.running ? this.stopCamera() : void this.startCamera()));
    this.els.camMirror.addEventListener("change", () => void emit("mirror", { on: this.els.camMirror.checked }).catch(() => {}));
    this.els.camHands.addEventListener("change", () => {
      if (this.capture) this.capture.hands = this.els.camHands.checked;
    });
    this.els.camRecord.addEventListener("click", () => this.toggleRecording());
    this.els.camSave.addEventListener("click", () => void this.saveRecording());

    void listenEvent<string>("settings-tab", (e) => this.openTab(e.payload));
    void invoke<string | null>("take_settings_tab")
      .then((tab) => {
        if (tab) this.openTab(tab);
      })
      .catch(() => {});

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.capture?.running) this.stopCamera();
    });
    void listenEvent("settings-hidden", () => {
      if (this.capture?.running) this.stopCamera();
    });

    this.els.tabs.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
      if (b && b.dataset.tab !== "capture" && this.capture?.running) this.stopCamera();
    });
  }

  async startCamera() {
    if (!this.capture) {
      this.capture = new Capture(this.els.cam, this.els.camOverlay);
      this.capture.hands = this.els.camHands.checked;
      this.capture.onStatus = (t) => (this.els.camStatus.textContent = t);
      this.capture.onPose = (pose, t) => {
        this.ctx.getLive().mirror = pose;
        if (this.recording) {
          this.recorder.push(pose, t);
          this.els.camRecStatus.textContent = `Recording… ${this.recorder.seconds.toFixed(1)} s`;
        }
        if (this.els.camMirror.checked) void emit("pose", pose).catch(() => {});
        if ((this.poseSeq++ & 31) === 0 && this.capture) {
          this.els.camStatus.textContent = `Tracking at ${this.capture.fps} fps${
            this.capture.hands ? `, ${this.capture.handsSeen} hand${this.capture.handsSeen === 1 ? "" : "s"}` : ""
          }.`;
        }
      };
    }
    try {
      await this.capture.start();
      this.els.camEmpty.hidden = true;
      this.els.camStart.textContent = "Stop camera";
      this.els.camRecord.disabled = false;
    } catch (err) {
      this.els.camStatus.textContent = `Camera failed: ${String(err).slice(0, 120)}`;
    }
  }

  stopCamera() {
    this.capture?.stop();
    if (this.recording) this.toggleRecording();
    this.ctx.getLive().mirror = null;
    this.els.camEmpty.hidden = false;
    this.els.camStart.textContent = "Start camera";
    this.els.camRecord.disabled = true;
    if (this.els.camMirror.checked) {
      this.els.camMirror.checked = false;
      void emit("mirror", { on: false }).catch(() => {});
    }
  }

  toggleRecording() {
    this.recording = !this.recording;
    if (this.recording) {
      this.recorder.begin();
      this.els.camRecord.textContent = "■ Stop";
      this.els.camRecStatus.textContent = "Recording… 0.0 s";
      this.els.camSave.disabled = true;
    } else {
      this.els.camRecord.textContent = "● Record";
      this.lastRecorded = { seconds: this.recorder.seconds };
      this.els.camRecStatus.textContent =
        this.recorder.count > 5
          ? `${this.recorder.seconds.toFixed(1)} s captured (${this.recorder.count} frames).`
          : "Too short; try again.";
      this.els.camSave.disabled = this.recorder.count <= 5;
    }
  }

  async saveRecording() {
    if (!this.lastRecorded || this.recorder.count <= 5) return;
    const name = (
      this.els.camName.value.trim() || `capture-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`
    ).replace(/[^A-Za-z0-9_-]+/g, "_");
    this.els.camSave.disabled = true;
    this.els.camSaveStatus.textContent = "Building the clip…";
    try {
      const canon = await canonicalRig();
      const clip = this.recorder.toClip(canon, name, this.els.camLoop.checked);
      if (!clip) throw new Error("not enough frames");
      const glb = await exportClipGlb(canon, clip);
      const saved = await invoke<string>("save_user_clip", new Uint8Array(glb), { headers: { "x-clip-name": name } });
      invalidateLibrary();
      const role = this.els.camRole.value;
      if (role !== "off") {
        const settings = this.ctx.getSettings();
        await this.ctx.commit({ animRoles: { ...(settings.animRoles ?? {}), [saved]: role } });
      }
      await this.ctx.renderLibrary();
      this.els.camSaveStatus.textContent = `Saved "${saved}" (${this.lastRecorded.seconds.toFixed(1)} s)${
        role !== "off" ? ` as ${role}` : ""
      }. It is on the Animations tab now.`;
      this.els.camName.value = "";
    } catch (err) {
      this.els.camSaveStatus.textContent = `Could not save: ${String(err).slice(0, 120)}`;
      this.els.camSave.disabled = false;
    }
  }

  openTab(name: string) {
    if (name === "capture") void this.openCapture();
    else showTab(name);
  }

  async openCapture() {
    showTab("capture");
    await this.startCamera();
    if (this.capture?.running && !this.els.camMirror.checked) {
      this.els.camMirror.checked = true;
      void emit("mirror", { on: true }).catch(() => {});
    }
  }
}

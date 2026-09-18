import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { defaultPersona, type LineEvent, Voice } from "../chat";
import {
  listPersonalities,
  loadUserPersonalities,
  saveUserPersonalities,
  slugFor,
  type Personality,
} from "../personality";
import { savePackPersona, type Manifest, type PackRef } from "../packs";
import type { Settings } from "../settings-store";
import { $, type SettingsContext, type TabModule } from "./types";

export const PROVIDERS: Record<string, { endpoint: string; model: string; stt: string; keyHint: string }> = {
  groq: { endpoint: "https://api.groq.com/openai/v1", model: "groq/compound", stt: "whisper-large-v3-turbo", keyHint: "free at console.groq.com/keys" },
  gemini: { endpoint: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash", stt: "", keyHint: "free at aistudio.google.com/apikey" },
  openai: { endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini", stt: "whisper-1", keyHint: "platform.openai.com/api-keys" },
  ollama: { endpoint: "http://localhost:11434/v1", model: "llama3.2", stt: "", keyHint: "not needed" },
  custom: { endpoint: "", model: "", stt: "", keyHint: "for your endpoint" },
};

export const LINE_EVENTS: Array<[LineEvent, string]> = [
  ["greet", "On start"],
  ["poked", "When poked"],
  ["idle", "Idle remarks"],
  ["dance", "Music starts"],
  ["land", "After a landing"],
  ["sleep", "Falling asleep"],
  ["wake", "Waking up"],
];

interface PiperStatus {
  root: string;
  exe: string | null;
  voices: Array<{ name: string; path: string }>;
  catalogue: Array<{ id: string; label: string }>;
}

function hotkeyFrom(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Win");
  const code = e.code;
  let key = "";
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^(F[1-9]|F1[0-9]|F2[0-4]|Numpad[0-9])$/.test(code)) key = code;
  else if (/^(Space|Tab|Enter|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right))$/.test(code)) key = code;
  else if (/^(Semicolon|Equal|Comma|Minus|Period|Slash|Backquote|BracketLeft|Backslash|BracketRight|Quote)$/.test(code)) key = code;
  if (!key) return null;
  if (!parts.length) return null;
  parts.push(key);
  return parts.join("+");
}

export class TalkTab implements TabModule {
  private ctx!: SettingsContext;
  private profiles: Personality[] = [];
  private editorBaseline = "";

  private els = {
    chatEnabled: $<HTMLInputElement>("chat-enabled"),
    talkFields: $<HTMLDivElement>("talk-fields"),
    talkMode: $<HTMLSelectElement>("talk-mode"),
    liveFields: $<HTMLDivElement>("live-fields"),
    pipelineFields: $<HTMLDivElement>("pipeline-fields"),
    liveKey: $<HTMLInputElement>("live-key"),
    liveSaveKey: $<HTMLButtonElement>("live-savekey"),
    liveKeyStatus: $<HTMLSpanElement>("live-keystatus"),
    liveBackend: $<HTMLInputElement>("live-backend"),
    liveVoice: $<HTMLInputElement>("live-voice"),
    liveMinutes: $<HTMLInputElement>("live-minutes"),
    liveUsage: $<HTMLParagraphElement>("live-usage"),
    talkHotkeyEnabled: $<HTMLInputElement>("talk-hotkey-enabled"),
    talkHotkey: $<HTMLInputElement>("talk-hotkey"),
    talkHotkeyReset: $<HTMLButtonElement>("talk-hotkey-reset"),
    talkHotkeyStatus: $<HTMLParagraphElement>("talk-hotkey-status"),
    pushHotkeyEnabled: $<HTMLInputElement>("push-hotkey-enabled"),
    pushHotkey: $<HTMLInputElement>("push-hotkey"),
    pushHotkeyReset: $<HTMLButtonElement>("push-hotkey-reset"),
    pushHotkeyStatus: $<HTMLParagraphElement>("push-hotkey-status"),
    personality: $<HTMLSelectElement>("personality"),
    personalityHint: $<HTMLParagraphElement>("personality-hint"),
    personalityEdit: $<HTMLButtonElement>("personality-edit"),
    pedit: $<HTMLDivElement>("pedit"),
    peName: $<HTMLInputElement>("pe-name"),
    peTemp: $<HTMLInputElement>("pe-temp"),
    peWords: $<HTMLInputElement>("pe-words"),
    peDesc: $<HTMLInputElement>("pe-desc"),
    pePersona: $<HTMLTextAreaElement>("pe-persona"),
    peLines: $<HTMLDivElement>("pe-lines"),
    peSave: $<HTMLButtonElement>("pe-save"),
    peSaveAs: $<HTMLButtonElement>("pe-saveas"),
    peDelete: $<HTMLButtonElement>("pe-delete"),
    peClose: $<HTMLButtonElement>("pe-close"),
    peStatus: $<HTMLSpanElement>("pe-status"),
    chatProvider: $<HTMLSelectElement>("chat-provider"),
    chatEndpoint: $<HTMLInputElement>("chat-endpoint"),
    chatModel: $<HTMLInputElement>("chat-model"),
    chatStt: $<HTMLInputElement>("chat-stt"),
    chatVoice: $<HTMLInputElement>("chat-voice"),
    chatLines: $<HTMLInputElement>("chat-lines"),
    chatCap: $<HTMLInputElement>("chat-cap"),
    ttsEngine: $<HTMLSelectElement>("tts-engine"),
    piperFields: $<HTMLDivElement>("piper-fields"),
    piperExe: $<HTMLInputElement>("piper-exe"),
    piperVoice: $<HTMLSelectElement>("piper-voice"),
    piperVoicePath: $<HTMLInputElement>("piper-voice-path"),
    piperDelete: $<HTMLButtonElement>("piper-delete"),
    piperInstall: $<HTMLButtonElement>("piper-install"),
    piperOpen: $<HTMLButtonElement>("piper-open"),
    piperDownload: $<HTMLButtonElement>("piper-download"),
    piperAdd: $<HTMLSelectElement>("piper-add"),
    piperAddStatus: $<HTMLParagraphElement>("piper-addstatus"),
    piperStatus: $<HTMLParagraphElement>("piper-status"),
    chatModels: $<HTMLDataListElement>("chat-models"),
    sttModels: $<HTMLDataListElement>("stt-models"),
    chatModelsRefresh: $<HTMLButtonElement>("chat-models-refresh"),
    chatModelsStatus: $<HTMLSpanElement>("chat-models-status"),
    chatKey: $<HTMLInputElement>("chat-key"),
    chatKeyHint: $<HTMLSpanElement>("chat-keyhint"),
    chatSaveKey: $<HTMLButtonElement>("chat-savekey"),
    chatKeyStatus: $<HTMLParagraphElement>("chat-keystatus"),
    chatTest: $<HTMLButtonElement>("chat-test"),
    chatTestStatus: $<HTMLParagraphElement>("chat-teststatus"),
    voicePreview: $<HTMLButtonElement>("voice-preview"),
    voicePreviewStatus: $<HTMLParagraphElement>("voice-preview-status"),
  };

  init(ctx: SettingsContext): void {
    this.ctx = ctx;

    this.els.chatEnabled.addEventListener("change", () => {
      this.els.talkFields.classList.toggle("off", !this.els.chatEnabled.checked);
      void ctx.commit({ chatEnabled: this.els.chatEnabled.checked });
    });

    this.wireLive();
    this.wireTalkHotkey();
    this.wireVoicePreview();
    this.wirePipeline();
    this.wirePersonalityEditor();
  }

  async postInit(): Promise<void> {
    await this.fillPersonalities();
    void this.refreshKeyStatus();
    void this.refreshLiveStatus();
    void this.refreshPiper();
    void this.refreshModels();
  }

  render(settings: Settings): void {
    this.els.chatEnabled.checked = settings.chatEnabled;
    this.els.talkFields.classList.toggle("off", !settings.chatEnabled);

    this.els.talkMode.value = settings.talkMode === "live" ? "live" : "pipeline";
    this.els.liveFields.hidden = settings.talkMode !== "live";
    this.els.pipelineFields.classList.toggle("dim", settings.talkMode === "live");
    this.els.liveBackend.value = settings.liveBackendModel;
    this.els.liveVoice.value = settings.liveVoice;
    this.els.liveMinutes.value = String(settings.liveDailyMinutes);
    if (settings.talkMode === "live") void this.refreshLiveStatus();

    this.els.talkHotkeyEnabled.checked = settings.talkHotkeyEnabled;
    this.els.talkHotkey.value = settings.talkHotkey;
    this.els.talkHotkey.disabled = !settings.talkHotkeyEnabled;
    this.els.pushHotkeyEnabled.checked = settings.pushHotkeyEnabled;
    this.els.pushHotkey.value = settings.pushHotkey;
    this.els.pushHotkey.disabled = !settings.pushHotkeyEnabled;

    this.els.chatProvider.value = settings.chatProvider;
    this.els.chatEndpoint.value = settings.chatEndpoint;
    this.els.chatModel.value = settings.chatModel;
    this.els.chatStt.value = settings.chatSttModel;
    this.els.chatVoice.checked = settings.chatVoice;
    this.els.chatLines.checked = settings.chatGenerateLines;
    this.els.chatCap.value = String(settings.chatDailyCap);

    this.els.ttsEngine.value = settings.ttsEngine;
    this.els.piperFields.hidden = settings.ttsEngine !== "piper";
    this.els.piperExe.value = settings.piperExe;
    this.els.piperVoicePath.value = settings.piperVoice;
    if (this.els.piperVoice.options.length) this.els.piperVoice.value = settings.piperVoice;

    if (this.els.personality.options.length) {
      this.els.personality.value = settings.personality;
      this.els.personalityHint.textContent = this.els.personality.selectedOptions[0]?.dataset.desc ?? "";
    }
    this.els.chatKeyHint.textContent = PROVIDERS[settings.chatProvider]?.keyHint ?? "for your endpoint";
  }

  private wireLive(): void {
    this.els.talkMode.addEventListener("change", () => {
      const live = this.els.talkMode.value === "live";
      this.els.liveFields.hidden = !live;
      this.els.pipelineFields.classList.toggle("dim", live);
      void this.ctx.commit({ talkMode: live ? "live" : "pipeline" });
      if (live) void this.refreshLiveStatus();
    });
    this.els.liveBackend.addEventListener("change", () =>
      void this.ctx.commit({ liveBackendModel: this.els.liveBackend.value.trim() || "gpt-5.6-luna" })
    );
    this.els.liveVoice.addEventListener("change", () =>
      void this.ctx.commit({ liveVoice: this.els.liveVoice.value.trim() })
    );
    this.els.liveMinutes.addEventListener("change", () =>
      void this.ctx.commit({ liveDailyMinutes: Math.max(0, Math.round(Number(this.els.liveMinutes.value) || 0)) })
    );
    this.els.liveSaveKey.addEventListener("click", async () => {
      try {
        await invoke("set_live_key", { key: this.els.liveKey.value });
        this.els.liveKey.value = "";
        await this.refreshLiveStatus();
        this.els.liveKeyStatus.textContent = "key saved";
      } catch (err) {
        this.els.liveKeyStatus.textContent = `could not save: ${err}`;
      }
    });
    this.els.liveKey.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.els.liveSaveKey.click();
    });
  }

  private wireTalkHotkey(): void {
    this.els.talkHotkeyEnabled.addEventListener("change", () => {
      this.els.talkHotkey.disabled = !this.els.talkHotkeyEnabled.checked;
      this.els.talkHotkeyStatus.textContent = this.els.talkHotkeyEnabled.checked ? "" : "Hotkey off.";
      void this.ctx.commit({ talkHotkeyEnabled: this.els.talkHotkeyEnabled.checked });
    });
    this.els.talkHotkey.addEventListener("focus", () => {
      this.els.talkHotkeyStatus.textContent = "Press the combo you want…";
    });
    this.els.talkHotkey.addEventListener("keydown", (e) => {
      e.preventDefault();
      if (e.key === "Escape") {
        this.els.talkHotkey.blur();
        return;
      }
      const combo = hotkeyFrom(e);
      if (!combo) {
        this.els.talkHotkeyStatus.textContent = "Hold Ctrl, Alt, Shift or Win, then press a key.";
        return;
      }
      this.els.talkHotkey.value = combo;
      this.els.talkHotkeyStatus.textContent = "Registering…";
      void this.ctx.commit({ talkHotkey: combo });
    });
    this.els.talkHotkeyReset.addEventListener("click", () => {
      this.els.talkHotkey.value = "Ctrl+Shift+T";
      void this.ctx.commit({ talkHotkey: "Ctrl+Shift+T" });
    });

    this.els.pushHotkeyEnabled.addEventListener("change", () => {
      this.els.pushHotkey.disabled = !this.els.pushHotkeyEnabled.checked;
      this.els.pushHotkeyStatus.textContent = this.els.pushHotkeyEnabled.checked ? "" : "Push to talk off.";
      void this.ctx.commit({ pushHotkeyEnabled: this.els.pushHotkeyEnabled.checked });
    });
    this.els.pushHotkey.addEventListener("focus", () => {
      this.els.pushHotkeyStatus.textContent = "Press the combo you want\u2026";
    });
    this.els.pushHotkey.addEventListener("keydown", (e) => {
      e.preventDefault();
      if (e.key === "Escape") {
        this.els.pushHotkey.blur();
        return;
      }
      const combo = hotkeyFrom(e);
      if (!combo) {
        this.els.pushHotkeyStatus.textContent = "Hold Ctrl, Alt, Shift or Win, then press a key.";
        return;
      }
      this.els.pushHotkey.value = combo;
      this.els.pushHotkeyStatus.textContent = "Registering\u2026";
      void this.ctx.commit({ pushHotkey: combo });
    });
    this.els.pushHotkeyReset.addEventListener("click", () => {
      this.els.pushHotkey.value = "Ctrl+Shift+Space";
      void this.ctx.commit({ pushHotkey: "Ctrl+Shift+Space" });
    });

    void listen<{ which?: string; key: string; ok: boolean; error: string }>("talk-hotkey", (e) => {
      const where = e.payload.which === "push" ? this.els.pushHotkeyStatus : this.els.talkHotkeyStatus;
      where.textContent = e.payload.ok ? `${e.payload.key} is listening.` : e.payload.error;
    });
  }

  private wireVoicePreview(): void {
    const voice = new Voice();
    voice.onError = (msg) => (this.els.voicePreviewStatus.textContent = msg);
    this.els.voicePreview.addEventListener("click", () => {
      const manifest = this.ctx.getCurrentManifest();
      const name = manifest?.name ?? "your buddy";
      voice.engine = this.els.ttsEngine.value === "piper" ? "piper" : "windows";
      this.els.voicePreviewStatus.textContent =
        voice.engine === "piper" && !this.els.piperVoice.value ? "Pick a Piper voice first." : "Speaking…";
      if (voice.engine === "piper" && !this.els.piperVoice.value) return;
      voice.say(`Hi, I'm ${name}. This is how I sound.`);
      setTimeout(() => {
        if (this.els.voicePreviewStatus.textContent === "Speaking…") this.els.voicePreviewStatus.textContent = "";
      }, 4000);
    });
  }

  private wirePipeline(): void {
    this.els.chatProvider.addEventListener("change", () => {
      const p = PROVIDERS[this.els.chatProvider.value];
      if (p && this.els.chatProvider.value !== "custom") {
        this.els.chatEndpoint.value = p.endpoint;
        this.els.chatModel.value = p.model;
        this.els.chatStt.value = p.stt;
      }
      this.els.chatKeyHint.textContent = p?.keyHint ?? "";
      void this.ctx
        .commit({
          chatProvider: this.els.chatProvider.value,
          chatEndpoint: this.els.chatEndpoint.value.trim(),
          chatModel: this.els.chatModel.value.trim(),
          chatSttModel: this.els.chatStt.value.trim(),
        })
        .then(() => this.refreshModels());
    });
    this.els.chatEndpoint.addEventListener("change", () =>
      void this.ctx.commit({ chatEndpoint: this.els.chatEndpoint.value.trim() })
    );
    this.els.chatModel.addEventListener("change", () =>
      void this.ctx.commit({ chatModel: this.els.chatModel.value.trim() })
    );
    this.els.chatStt.addEventListener("change", () =>
      void this.ctx.commit({ chatSttModel: this.els.chatStt.value.trim() })
    );
    this.els.chatVoice.addEventListener("change", () =>
      void this.ctx.commit({ chatVoice: this.els.chatVoice.checked })
    );
    this.els.chatLines.addEventListener("change", () =>
      void this.ctx.commit({ chatGenerateLines: this.els.chatLines.checked })
    );
    this.els.chatCap.addEventListener("change", () =>
      void this.ctx.commit({ chatDailyCap: Math.max(0, Math.round(Number(this.els.chatCap.value) || 0)) })
    );

    this.els.ttsEngine.addEventListener("change", () => {
      this.els.piperFields.hidden = this.els.ttsEngine.value !== "piper";
      void this.ctx.commit({ ttsEngine: this.els.ttsEngine.value });
      if (this.els.ttsEngine.value === "piper") void this.refreshPiper();
    });
    this.els.piperExe.addEventListener("change", () =>
      void this.ctx.commit({ piperExe: this.els.piperExe.value.trim().replace(/^"|"$/g, "") })
    );
    this.els.piperVoicePath.addEventListener("change", () =>
      void this.ctx.commit({ piperVoice: this.els.piperVoicePath.value.trim().replace(/^"|"$/g, "") })
    );
    this.els.piperVoice.addEventListener("change", () => {
      this.els.piperVoicePath.value = this.els.piperVoice.value;
      void this.ctx.commit({ piperVoice: this.els.piperVoice.value });
    });
    this.els.piperInstall.addEventListener("click", async () => {
      this.els.piperInstall.disabled = true;
      this.els.piperStatus.textContent = "Downloading Piper (22 MB)…";
      try {
        const exe = await invoke<string>("piper_install");
        await this.ctx.commit({ piperExe: exe });
        this.els.piperExe.value = exe;
        await this.refreshPiper();
      } catch (err) {
        this.els.piperStatus.textContent = `Install failed: ${err}`;
        this.els.piperInstall.disabled = false;
      }
    });
    this.els.piperOpen.addEventListener("click", () => void invoke("piper_open_voices").catch(() => {}));
    this.els.piperDelete.addEventListener("click", async () => {
      const path = this.els.piperVoice.value;
      const name = this.els.piperVoice.selectedOptions[0]?.textContent ?? path;
      if (!path) return;
      const sure = await ask(`Delete the voice "${name}"?`, {
        title: "Delete voice",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Keep",
      });
      if (!sure) return;
      try {
        await invoke("piper_delete_voice", { path });
        if (this.ctx.getSettings().piperVoice === path) await this.ctx.commit({ piperVoice: "" });
        this.els.piperAddStatus.textContent = `Deleted ${name}.`;
        await this.refreshPiper();
      } catch (err) {
        this.els.piperAddStatus.textContent = `Could not delete: ${err}`;
      }
    });
    this.els.piperDownload.addEventListener("click", async () => {
      const id = this.els.piperAdd.value;
      if (!id) return;
      this.els.piperDownload.disabled = true;
      this.els.piperAddStatus.textContent = `Downloading ${id}… (about 60 MB)`;
      try {
        const path = await invoke<string>("piper_download_voice", { id });
        await this.ctx.commit({ piperVoice: path });
        this.els.piperAddStatus.textContent = `Added ${id} and selected it.`;
        await this.refreshPiper();
      } catch (err) {
        this.els.piperAddStatus.textContent = `Download failed: ${err}`;
      } finally {
        this.els.piperDownload.disabled = false;
      }
    });
    this.els.chatModelsRefresh.addEventListener("click", () => void this.refreshModels());

    this.els.personality.addEventListener("change", async () => {
      const previous = this.ctx.getSettings().personality;
      const selected = this.els.personality.value;
      this.els.personality.disabled = true;
      try {
        if (
          !this.els.pedit.hidden &&
          this.editorDirty() &&
          !(await ask("Discard unsaved personality edits and switch profiles?", {
            title: "Unsaved personality edits",
            kind: "warning",
            okLabel: "Discard and switch",
            cancelLabel: "Cancel",
          }))
        ) {
          this.els.personality.value = previous;
          return;
        }
        await this.ctx.commit({ personality: selected });
        this.els.personalityHint.textContent = this.els.personality.selectedOptions[0]?.dataset.desc ?? "";
        if (!this.els.pedit.hidden) {
          const profile = this.profiles.find((p) => p.id === selected);
          if (profile) this.showEditor(profile);
        }
      } finally {
        this.els.personality.disabled = false;
      }
    });

    this.els.chatSaveKey.addEventListener("click", async () => {
      try {
        await invoke("set_chat_key", { key: this.els.chatKey.value });
        this.els.chatKey.value = "";
        await this.refreshKeyStatus();
        this.els.chatKeyStatus.textContent = "Key saved. " + this.els.chatKeyStatus.textContent;
        void this.refreshModels();
      } catch (err) {
        this.els.chatKeyStatus.textContent = `Could not save the key: ${err}`;
      }
    });
    this.els.chatKey.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.els.chatSaveKey.click();
    });

    this.els.chatTest.addEventListener("click", async () => {
      this.els.chatTestStatus.textContent = "Asking…";
      this.els.chatTest.disabled = true;
      try {
        const reply = await invoke<string>("chat_complete", {
          messages: [
            { role: "system", content: "You are a desktop buddy. Reply with one short, friendly sentence." },
            { role: "user", content: "Say hi and tell me you can hear me." },
          ],
          maxTokens: 60,
        });
        this.els.chatTestStatus.textContent = `He says: ${reply}`;
      } catch (err) {
        this.els.chatTestStatus.textContent = `Failed: ${err}`;
      } finally {
        this.els.chatTest.disabled = false;
        void this.refreshKeyStatus();
      }
    });
  }

  async refreshPiper(): Promise<void> {
    let st: PiperStatus;
    try {
      st = await invoke<PiperStatus>("piper_status");
    } catch (err) {
      this.els.piperStatus.textContent = `Piper: ${err}`;
      return;
    }
    const settings = this.ctx.getSettings();
    const managed = !!st.exe;
    const custom = settings.piperExe && st.exe !== settings.piperExe && settings.piperExe.trim() !== "";
    this.els.piperStatus.textContent = managed
      ? `Piper is installed${custom ? " (using your own piper.exe instead)" : ""}.`
      : settings.piperExe
        ? "Using your own piper.exe."
        : "Piper is not installed yet.";
    this.els.piperInstall.hidden = managed;
    this.els.piperInstall.disabled = false;
    if (managed && !settings.piperExe) {
      await this.ctx.commit({ piperExe: st.exe! });
      this.els.piperExe.value = st.exe!;
    }
    this.els.piperVoice.innerHTML = "";
    if (!st.voices.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "no voices yet: download one below or drop .onnx files in the folder";
      this.els.piperVoice.appendChild(o);
    }
    for (const v of st.voices) {
      const o = document.createElement("option");
      o.value = v.path;
      o.textContent = v.name;
      this.els.piperVoice.appendChild(o);
    }
    if (settings.piperVoice && !st.voices.some((v) => v.path === settings.piperVoice)) {
      const o = document.createElement("option");
      o.value = settings.piperVoice;
      o.textContent = `${settings.piperVoice.split(/[\\/]/).pop()} (custom path)`;
      this.els.piperVoice.appendChild(o);
    }
    if (settings.piperVoice) this.els.piperVoice.value = settings.piperVoice;
    else if (st.voices.length) {
      this.els.piperVoice.value = st.voices[0].path;
      this.els.piperVoicePath.value = st.voices[0].path;
      await this.ctx.commit({ piperVoice: st.voices[0].path });
    }
    this.els.piperAdd.innerHTML = "";
    for (const c of st.catalogue) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = st.voices.some((v) => v.name === c.id) ? `${c.label} (installed)` : c.label;
      this.els.piperAdd.appendChild(o);
    }
  }

  async refreshModels(): Promise<void> {
    this.els.chatModelsStatus.textContent = "Fetching models…";
    try {
      const ids = await invoke<string[]>("list_models");
      this.els.chatModels.innerHTML = "";
      this.els.sttModels.innerHTML = "";
      for (const id of ids) {
        const o = document.createElement("option");
        o.value = id;
        (/whisper|transcri|speech/i.test(id) ? this.els.sttModels : this.els.chatModels).appendChild(o);
      }
      this.els.chatModelsStatus.textContent = ids.length
        ? `${ids.length} models available; click the box to pick one.`
        : "The endpoint listed no models.";
    } catch (err) {
      this.els.chatModelsStatus.textContent = `Could not list models: ${err}`;
    }
  }

  async refreshKeyStatus(): Promise<void> {
    try {
      const has = await invoke<boolean>("has_chat_key");
      const used = await invoke<number>("chat_usage");
      this.els.chatKeyStatus.textContent =
        (has ? "A key is saved." : "No key saved.") + (used ? ` ${used} requests today.` : "");
    } catch {
      this.els.chatKeyStatus.textContent = "";
    }
  }

  async refreshLiveStatus(): Promise<void> {
    try {
      const has = await invoke<boolean>("has_live_key");
      const secs = await invoke<number>("live_usage");
      this.els.liveKeyStatus.textContent = has ? "a key is saved" : "no key saved";
      this.els.liveUsage.textContent =
        secs > 0 ? `${(secs / 60).toFixed(1)} minutes of Live voice used today.` : "No Live voice used today.";
    } catch {
      this.els.liveKeyStatus.textContent = "";
    }
  }

  async fillPersonalities(): Promise<void> {
    this.profiles = await listPersonalities();
    this.els.personality.innerHTML = "";
    for (const p of this.profiles) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.user ? `${p.name} (yours)` : p.name;
      o.dataset.desc = p.description ?? "";
      this.els.personality.appendChild(o);
    }
    const current = this.ctx.getSettings()?.personality ?? "pack";
    this.els.personality.value = current;
    if (!this.els.personality.value) this.els.personality.value = "pack";
    this.els.personalityHint.textContent = this.els.personality.selectedOptions[0]?.dataset.desc ?? "";
  }

  private editorToProfile(id: string): Personality {
    const lines: Partial<Record<LineEvent, string[]>> = {};
    for (const [key] of LINE_EVENTS) {
      const ta = document.getElementById(`pe-line-${key}`) as HTMLTextAreaElement | null;
      const arr = (ta?.value ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
      if (arr.length) lines[key] = arr;
    }
    return {
      id,
      name: this.els.peName.value.trim() || "Untitled",
      description: this.els.peDesc.value.trim() || undefined,
      persona: this.els.pePersona.value.trim() || undefined,
      lines: Object.keys(lines).length ? lines : undefined,
      llm: { temperature: Number(this.els.peTemp.value) || 0.9, maxWords: Number(this.els.peWords.value) || 35 },
    };
  }

  private editorSnapshot(): string {
    return JSON.stringify(
      Array.from(this.els.pedit.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")).map(
        (el) => el.value
      )
    );
  }

  private editorDirty(): boolean {
    return this.editorSnapshot() !== this.editorBaseline;
  }

  private editablePack(): PackRef | null {
    const pack = this.ctx.getPacks().find((x) => x.id === this.ctx.getSettings().character);
    return pack && !pack.bundled ? pack : null;
  }

  showEditor(p: Personality): void {
    this.els.pedit.hidden = false;
    const ownPack = p.id === "pack" ? this.editablePack() : null;
    const editable = !!p.user || !!ownPack;
    const manifest = this.ctx.getCurrentManifest();
    const packName = manifest?.name ?? "Buddy";
    const packLlm = p.id === "pack" ? manifest?.llm : undefined;
    const persona =
      p.persona ?? (p.id === "pack" ? manifest?.persona ?? defaultPersona(packName, packLlm?.maxWords ?? 35) : "");
    const lines = p.lines ?? (p.id === "pack" ? ((manifest?.lines ?? {}) as Personality["lines"]) : undefined);
    this.els.peName.value = p.id === "pack" ? `${packName} (as the character)` : p.name;
    this.els.peDesc.value = p.description ?? "";
    this.els.pePersona.value = persona;
    this.els.peTemp.value = String(packLlm?.temperature ?? p.llm?.temperature ?? 0.9);
    this.els.peWords.value = String(packLlm?.maxWords ?? p.llm?.maxWords ?? 35);
    for (const el of [this.els.peName, this.els.peDesc]) el.readOnly = !p.user;
    for (const el of [this.els.pePersona, this.els.peTemp, this.els.peWords]) el.readOnly = !editable;
    this.els.peLines.innerHTML = "";
    for (const [key, label] of LINE_EVENTS) {
      const l = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = label;
      const ta = document.createElement("textarea");
      ta.id = `pe-line-${key}`;
      ta.value = (lines?.[key] ?? []).join("\n");
      ta.readOnly = !editable;
      l.append(span, ta);
      this.els.peLines.appendChild(l);
    }
    this.els.peSave.disabled = !editable;
    this.els.peDelete.disabled = !p.user;
    this.els.peSaveAs.textContent = editable ? "Save as new" : "Copy to a new profile";
    this.els.peStatus.textContent = ownPack
      ? `Saving writes this into "${ownPack.name}" itself, so it stays with that character.`
      : editable
        ? ""
        : p.id === "pack"
          ? "This character ships with the app, so its own personality is read-only. Copy it to a new profile to change anything."
          : "Built in and read-only. Copy it to a new profile to change anything.";
    this.editorBaseline = this.editorSnapshot();
  }

  private wirePersonalityEditor(): void {
    this.els.personalityEdit.addEventListener("click", () => {
      if (!this.els.pedit.hidden) {
        this.els.pedit.hidden = true;
        return;
      }
      const p = this.profiles.find((x) => x.id === this.els.personality.value);
      if (p) this.showEditor(p);
    });
    this.els.peClose.addEventListener("click", () => (this.els.pedit.hidden = true));

    const persist = async (list: Personality[], select?: string) => {
      await saveUserPersonalities(list);
      await this.fillPersonalities();
      if (select) {
        this.els.personality.value = select;
        this.els.personalityHint.textContent = this.els.personality.selectedOptions[0]?.dataset.desc ?? "";
        await this.ctx.commit({ personality: select });
      }
      await emit("personalities-changed").catch(() => {});
    };

    this.els.peSaveAs.addEventListener("click", async () => {
      const users = await loadUserPersonalities();
      const baseName = this.els.peName.value.replace(/\s*\(as the character\)\s*$/i, "").trim() || "profile";
      this.els.peName.value = baseName;
      const id = slugFor(baseName, this.profiles.map((p) => p.id));
      const p = this.editorToProfile(id);
      await persist([...users, p], id);
      this.showEditor({ ...p, user: true });
      this.els.peStatus.textContent = `Saved as "${p.name}" and selected.`;
    });

    this.els.peSave.addEventListener("click", async () => {
      const id = this.els.personality.value;
      if (id === "pack") {
        const pack = this.editablePack();
        if (!pack) return;
        const p = this.editorToProfile(id);
        try {
          await savePackPersona(pack.id, p.persona, p.lines as Manifest["lines"], p.llm);
        } catch (err) {
          this.els.peStatus.textContent = `Could not save: ${err}`;
          return;
        }
        await this.ctx.updatePackDetails();
        await emit("personalities-changed").catch(() => {});
        this.showEditor({ id: "pack", name: "As the character" });
        this.els.peStatus.textContent = `Saved into "${pack.name}".`;
        return;
      }
      const users = await loadUserPersonalities();
      if (!users.some((u) => u.id === id)) return;
      const p = this.editorToProfile(id);
      await persist(users.map((u) => (u.id === id ? p : u)), id);
      this.showEditor({ ...p, user: true });
      this.els.peStatus.textContent = "Saved.";
    });

    this.els.peDelete.addEventListener("click", async () => {
      const id = this.els.personality.value;
      const users = await loadUserPersonalities();
      if (!users.some((u) => u.id === id)) return;
      await persist(users.filter((u) => u.id !== id), "pack");
      this.els.pedit.hidden = true;
    });
  }
}

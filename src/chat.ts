/**
 * Talking to the buddy. Three pieces:
 *  - ChatClient: a short conversation through the Rust `chat_complete` command (any
 *    OpenAI-compatible endpoint; the key never reaches this side).
 *  - TalkBox: the little input strip at his feet, with a microphone that records a clip and
 *    sends it for transcription.
 *  - Voice: speaks replies with the Windows voices through the WebView's speechSynthesis.
 * Plus phrase generation: fresh speech-bubble lines in the character's voice, cached per pack.
 */
import { invoke } from "@tauri-apps/api/core";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type LineEvent = "greet" | "poked" | "sleep" | "wake" | "land" | "dance" | "idle";
export type Lines = Partial<Record<LineEvent, string[]>>;

/** What he is, unless the pack says otherwise. */
export function defaultPersona(name: string): string {
  return (
    `You are ${name}, a small 3D character living on the user's Windows desktop, standing on the taskbar. ` +
    `You are warm, playful and a little cheeky, and you talk like a good friend, not an assistant. ` +
    `You can see the user's mouse, hear their music (you dance when it plays), you get poked, picked up, ` +
    `dragged around and thrown, and you doze off when ignored. ` +
    `Reply in one or two short sentences, at most 35 words, plain text only: no markdown, no lists, no emojis.`
  );
}

export class ChatClient {
  private history: ChatMessage[] = [];

  constructor(private persona: () => string) {}

  reset() {
    this.history = [];
  }

  /** Ask one thing; `context` is a line about what he is doing right now. */
  async ask(text: string, context: string): Promise<string> {
    const system: ChatMessage = { role: "system", content: `${this.persona()}\n${context}` };
    this.history.push({ role: "user", content: text });
    const messages = [system, ...this.history.slice(-10)];
    const reply = await invoke<string>("chat_complete", { messages, maxTokens: 120 });
    this.history.push({ role: "assistant", content: reply });
    return reply;
  }
}

const LINE_SPEC: Array<[LineEvent, number, string]> = [
  ["greet", 8, "when the app starts"],
  ["poked", 8, "when the user clicks (pokes) you"],
  ["sleep", 4, "as you doze off after being ignored"],
  ["wake", 4, "as you are woken up"],
  ["land", 6, "right after being thrown and hitting the floor"],
  ["dance", 6, "when music starts and you begin dancing"],
  ["idle", 14, "random remarks while standing around, about being a desktop buddy, the user's day, or nothing in particular"],
];

const PHRASE_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Speech-bubble lines in the character's voice, from the cache when fresh, otherwise
 * generated once and cached for a week. Returns null when nothing usable came back.
 */
export async function loadOrGeneratePhrases(packId: string, persona: string, force = false): Promise<Lines | null> {
  if (!force) {
    try {
      const cached = await invoke<string | null>("load_phrases", { pack: packId });
      if (cached) {
        const parsed = JSON.parse(cached) as { at: number; lines: Lines };
        if (parsed?.lines && Date.now() - parsed.at < PHRASE_TTL_MS) return parsed.lines;
      }
    } catch {
      /* no cache */
    }
  }
  const spec = LINE_SPEC.map(([k, n, when]) => `"${k}": ${n} lines said ${when}`).join(", ");
  const prompt =
    `Write speech-bubble lines for yourself. Each line is under 8 words, plain text, no emojis, no quotation marks, ` +
    `varied, in character. Return ONLY a JSON object with these keys and array-of-string values: ${spec}.`;
  const reply = await invoke<string>("chat_complete", {
    messages: [
      { role: "system", content: persona },
      { role: "user", content: prompt },
    ],
    maxTokens: 900,
  });
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const lines: Lines = {};
  for (const [key] of LINE_SPEC) {
    const arr = parsed[key];
    if (Array.isArray(arr)) {
      const clean = arr.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter((s) => s && s.length < 60);
      if (clean.length) lines[key] = clean;
    }
  }
  if (!Object.keys(lines).length) return null;
  await invoke("save_phrases", { pack: packId, json: JSON.stringify({ at: Date.now(), lines }) }).catch(() => {});
  return lines;
}

/** Windows voices through the WebView. */
export class Voice {
  speaking = false;
  enabled = true;

  say(text: string) {
    if (!this.enabled || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 1;
    u.onstart = () => (this.speaking = true);
    u.onend = u.onerror = () => (this.speaking = false);
    speechSynthesis.speak(u);
  }

  stop() {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.speaking = false;
  }
}

/** The input strip at his feet: type, or hold the mic button to talk. */
export class TalkBox {
  readonly el: HTMLDivElement;
  private input: HTMLInputElement;
  private mic: HTMLButtonElement;
  private send: HTMLButtonElement;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private stream: MediaStream | null = null;
  open = false;
  busy = false;
  /** Set by main: handles one utterance; resolves when the reply has been shown. */
  onSend?: (text: string) => Promise<void>;
  onOpenChange?: (open: boolean) => void;
  onStatus?: (text: string) => void;
  micEnabled = true;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "talk";
    this.el.hidden = true;
    this.mic = document.createElement("button");
    this.mic.type = "button";
    this.mic.textContent = "🎤";
    this.mic.title = "Click to talk, click again when done";
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.placeholder = "Say something… (Esc closes)";
    this.input.maxLength = 400;
    this.send = document.createElement("button");
    this.send.type = "button";
    this.send.textContent = "➤";
    this.send.title = "Send";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.title = "Close";
    this.el.append(this.mic, this.input, this.send, close);
    document.body.appendChild(this.el);

    this.send.addEventListener("click", () => void this.submit());
    close.addEventListener("click", () => this.hide());
    this.mic.addEventListener("click", () => void this.toggleRecording());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.hide();
      }
      e.stopPropagation();
    });
    // Keep the buddy's grab handling from seeing presses on the strip.
    for (const ev of ["pointerdown", "pointerup", "dblclick", "contextmenu"] as const) {
      this.el.addEventListener(ev, (e) => e.stopPropagation());
    }
  }

  show() {
    this.el.hidden = false;
    this.open = true;
    this.mic.hidden = !this.micEnabled;
    this.onOpenChange?.(true);
    setTimeout(() => this.input.focus(), 30);
  }

  hide() {
    if (this.recorder) this.stopRecording(true);
    this.el.hidden = true;
    this.open = false;
    this.onOpenChange?.(false);
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  /** Put text in the box (from transcription) and send it. */
  private async submit(text = this.input.value) {
    const line = text.trim();
    if (!line || this.busy || !this.onSend) return;
    this.input.value = "";
    this.setBusy(true);
    try {
      await this.onSend(line);
    } finally {
      this.setBusy(false);
      if (this.open) this.input.focus();
    }
  }

  private setBusy(b: boolean) {
    this.busy = b;
    this.el.classList.toggle("busy", b);
    this.input.disabled = b;
    this.send.disabled = b;
  }

  private async toggleRecording() {
    if (this.recorder) {
      this.stopRecording(false);
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      this.onStatus?.(`Microphone unavailable: ${String(err).slice(0, 60)}`);
      return;
    }
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    this.chunks = [];
    const rec = new MediaRecorder(this.stream, { mimeType: mime });
    rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    rec.onstop = () => void this.finishRecording(mime);
    rec.start(250);
    this.recorder = rec;
    this.mic.classList.add("rec");
    this.input.placeholder = "Listening… click the mic again when done";
    // Nobody talks for more than half a minute to a desk toy.
    setTimeout(() => {
      if (this.recorder === rec) this.stopRecording(false);
    }, 30_000);
  }

  private stopRecording(discard: boolean) {
    const rec = this.recorder;
    if (!rec) return;
    this.recorder = null;
    this.mic.classList.remove("rec");
    this.input.placeholder = "Say something… (Esc closes)";
    if (discard) rec.onstop = null;
    if (rec.state !== "inactive") rec.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private async finishRecording(mime: string) {
    const blob = new Blob(this.chunks, { type: mime });
    this.chunks = [];
    if (blob.size < 2000) return;
    this.setBusy(true);
    this.input.placeholder = "Transcribing…";
    try {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const text = await invoke<string>("transcribe", { audio: Array.from(buf), mime: mime.split(";")[0] });
      this.setBusy(false);
      if (text) {
        this.input.value = text;
        await this.submit(text);
      } else {
        this.onStatus?.("Didn't catch that.");
      }
    } catch (err) {
      this.setBusy(false);
      this.onStatus?.(String(err).slice(0, 80));
    } finally {
      this.input.placeholder = "Say something… (Esc closes)";
    }
  }
}

/**
 * Talking to the buddy. Three pieces:
 *  - ChatClient: a short conversation through the Rust `chat_complete` command (any
 *    OpenAI-compatible endpoint; the key never reaches this side).
 *  - TalkBox: the little input strip at his feet, with a microphone that records a clip and
 *    sends it for transcription, a history panel, and an idle timeout.
 *  - Voice: speaks replies with the Windows voices (speechSynthesis) or a local Piper voice.
 * Plus phrase generation: fresh speech-bubble lines in the character's voice, cached per pack
 * and personality.
 */
import { invoke } from "@tauri-apps/api/core";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type LineEvent = "greet" | "poked" | "sleep" | "wake" | "land" | "bump" | "dance" | "idle";
export type Lines = Partial<Record<LineEvent, string[]>>;

/** What he is, unless the pack or a personality says otherwise. */
export function defaultPersona(name: string, maxWords = 35): string {
  return (
    `You are ${name}, a small 3D character living on the user's Windows desktop, standing on the taskbar. ` +
    `You are warm, playful and a little cheeky, and you talk like a good friend, not an assistant. ` +
    `You can see the user's mouse, hear their music (you dance when it plays), you get poked, picked up, ` +
    `dragged around and thrown, and you doze off when ignored. ` +
    `Reply in one or two short sentences, at most ${maxWords} words, plain text only: no markdown, no lists, no emojis.`
  );
}

export interface ChatTuning {
  temperature: number;
  maxWords: number;
}

/**
 * Replies are shown in a bubble and read aloud, so strip anything that is not the answer:
 * <think> blocks, "Reasoning" sections that end in a "Response" marker, and markdown.
 */
export function cleanReply(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "");
  // "**Reasoning Recap** ... **Response** Good morning" -> keep what follows the last marker.
  const marker = /(?:^|\n|\*)\s*\**\s*(?:final\s+)?(?:response|answer|reply)\s*\**\s*[:\-\u2013]?\s*/gi;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(t)) !== null) last = m;
  if (last) t = t.slice(last.index + last[0].length);
  t = t
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,!?])/g, "$1$2")
    .replace(/^\s*[-*\u2022]\s+/gm, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  t = t || raw.trim();
  // A bubble can hold a couple of sentences; past that, keep whole sentences up to the cap.
  const CAP = 300;
  if (t.length > CAP) {
    const head = t.slice(0, CAP);
    const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
    t = cut > 80 ? head.slice(0, cut + 1) : head.replace(/\s+\S*$/, "") + "…";
  }
  return t;
}

export class ChatClient {
  private history: ChatMessage[] = [];
  tuning: ChatTuning = { temperature: 0.9, maxWords: 35 };

  constructor(private persona: () => string) {}

  reset() {
    this.history = [];
  }

  /** Ask one thing; `context` is a line about what he is doing right now. */
  async ask(text: string, context: string): Promise<string> {
    const system: ChatMessage = { role: "system", content: `${this.persona()}\n${context}` };
    this.history.push({ role: "user", content: text });
    const messages = [system, ...this.history.slice(-10)];
    const raw = await invoke<string>("chat_complete", {
      messages,
      maxTokens: Math.round(this.tuning.maxWords * 2 + 30),
      temperature: this.tuning.temperature,
    });
    const reply = cleanReply(raw);
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
  ["bump", 4, "when you bang your head on the top of the screen climbing onto a window that is too high, and fall off"],
  ["dance", 6, "when music starts and you begin dancing"],
  ["idle", 14, "random remarks while standing around, about being a desktop buddy, the user's day, or nothing in particular"],
];

const PHRASE_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Speech-bubble lines in the character's voice, from the cache when fresh, otherwise
 * generated once and cached for a week. `cacheKey` separates packs and personalities.
 * Returns null when nothing usable came back.
 */
export async function loadOrGeneratePhrases(cacheKey: string, persona: string, force = false): Promise<Lines | null> {
  if (!force) {
    try {
      const cached = await invoke<string | null>("load_phrases", { pack: cacheKey });
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
    temperature: 1.0,
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
  await invoke("save_phrases", { pack: cacheKey, json: JSON.stringify({ at: Date.now(), lines }) }).catch(() => {});
  return lines;
}

/** Spoken replies: the Windows voices through the WebView, or a local Piper voice. */
export class Voice {
  speaking = false;
  enabled = true;
  engine: "windows" | "piper" = "windows";
  /** performance.now() when speech last ended, for holding the music gate a moment after. */
  endedAt = -Infinity;
  onError?: (msg: string) => void;
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private seq = 0;

  /** True while speaking or within `graceMs` after speech ended. */
  busy(graceMs = 1500) {
    return this.speaking || performance.now() - this.endedAt < graceMs;
  }

  say(text: string) {
    if (!this.enabled) return;
    if (this.engine === "piper") void this.sayPiper(text);
    else this.sayWindows(text);
  }

  private sayWindows(text: string) {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 1;
    u.onstart = () => (this.speaking = true);
    u.onend = u.onerror = () => this.ended();
    speechSynthesis.speak(u);
  }

  private async sayPiper(text: string) {
    const my = ++this.seq;
    this.stopAudio();
    let bytes: ArrayBuffer;
    try {
      bytes = await invoke<ArrayBuffer>("speak_piper", { text });
    } catch (err) {
      this.onError?.(String(err).slice(0, 90));
      return;
    }
    if (my !== this.seq) return;
    this.url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    const a = new Audio(this.url);
    this.audio = a;
    a.onplay = () => (this.speaking = true);
    a.onended = a.onerror = a.onpause = () => {
      if (this.audio === a) this.ended();
    };
    a.play().catch((err) => this.onError?.(String(err).slice(0, 90)));
  }

  private ended() {
    this.speaking = false;
    this.endedAt = performance.now();
  }

  private stopAudio() {
    if (this.audio) {
      const a = this.audio;
      this.audio = null;
      a.pause();
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }

  stop() {
    this.seq++;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.stopAudio();
    if (this.speaking) this.ended();
  }
}

export interface TalkEntry {
  who: "you" | "him";
  text: string;
}

const TALK_IDLE_MS = 45_000;
const LOG_MAX = 30;

/** The input strip at his feet: type, or click the mic and talk. */
/** How loud a moment has to be, absolutely, to count as speech rather than room noise. */
const SPEECH_LEVEL = 0.05;
/** ...and how far above the quietest moment of the same recording. */
const SPEECH_OVER_ROOM = 2.5;
/** How many such moments a recording needs before it is worth transcribing; one per 50ms. */
const SPEECH_FRAMES = 4;

/**
 * Did anyone actually speak? Judged from the levels the meter is already measuring, one per
 * 50ms of recording.
 *
 * Whisper does not answer silence with silence. It answers with whatever it has heard most
 * often in the quiet, so an empty room comes back as "Thank you." or "Bye." and goes off to the
 * model for a reply. Once there is text there is no telling it from something that was really
 * said, so the recording has to be judged before it is sent.
 *
 * The quietest moment stands in for the room, and speech has to stand well clear of it: a hissy
 * microphone is then judged against its own hiss rather than a number picked on someone else's
 * desk. It has to clear a fixed level as well, for a room that is loud throughout. Wanting
 * several such moments keeps a cough or a knock from counting as a sentence.
 *
 * No levels at all means the meter never ran, and a recording is never thrown away over that.
 */
export function heardSpeech(levels: readonly number[]): boolean {
  if (levels.length === 0) return true;
  let floor = 1;
  for (const level of levels) floor = Math.min(floor, level);
  const bar = Math.max(SPEECH_LEVEL, floor * SPEECH_OVER_ROOM);
  let loud = 0;
  for (const level of levels) if (level > bar) loud++;
  return loud >= SPEECH_FRAMES;
}

export class TalkBox {
  readonly el: HTMLDivElement;
  private input: HTMLInputElement;
  private mic: HTMLButtonElement;
  private send: HTMLButtonElement;
  private logBtn: HTMLButtonElement;
  private logEl: HTMLDivElement;
  private vuMeter: HTMLDivElement;
  private recorder: MediaRecorder | null = null;
  private sttCtx: AudioContext | null = null;
  private sttTimer = 0;
  private chunks: BlobPart[] = [];
  private stream: MediaStream | null = null;
  private idleTimer = 0;
  private log: TalkEntry[] = [];
  open = false;
  busy = false;
  /** Set by main: handles one utterance; resolves when the reply has been shown. */
  onSend?: (text: string) => Promise<void>;
  onOpenChange?: (open: boolean) => void;
  onStatus?: (text: string) => void;
  /**
   * What the microphone is doing, for feedback outside this box: an empty string while it is
   * recording, the recognised words once they arrive, and null when there is nothing to show.
   * The talk box may well be closed, and the bubble over his head is then the only feedback
   * there is that anything was heard at all.
   */
  onHeard?: (text: string | null) => void;
  micEnabled = true;
  /** Live voice: when set, the mic button toggles mute instead of recording; returns the new muted state. */
  onMicToggle?: () => boolean;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "talk";
    this.el.hidden = true;
    this.mic = document.createElement("button");
    this.mic.type = "button";
    this.mic.textContent = "🎤";
    this.mic.title = "Click to talk, click again when done";
    this.vuMeter = document.createElement("div");
    this.vuMeter.className = "vu-meter";
    for (let i = 0; i < 4; i++) {
      const bar = document.createElement("span");
      bar.className = "bar";
      this.vuMeter.appendChild(bar);
    }
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.placeholder = "Say something… (Esc closes)";
    this.input.maxLength = 400;
    this.input.title = "Type here, or focus this box and press Windows + H to use Windows voice typing.";
    this.send = document.createElement("button");
    this.send.type = "button";
    this.send.textContent = "➤";
    this.send.title = "Send";
    this.logBtn = document.createElement("button");
    this.logBtn.type = "button";
    this.logBtn.textContent = "☰";
    this.logBtn.title = "Show what we said (this session)";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.title = "Close";
    this.el.append(this.mic, this.vuMeter, this.input, this.send, this.logBtn, close);
    this.logEl = document.createElement("div");
    this.logEl.className = "talk-log";
    this.logEl.hidden = true;
    document.body.append(this.logEl, this.el);

    this.send.addEventListener("click", () => void this.submit());
    close.addEventListener("click", () => this.hide());
    this.mic.addEventListener("click", () => {
      if (this.onMicToggle) {
        const muted = this.onMicToggle();
        this.mic.textContent = muted ? "🔇" : "🎤";
        this.mic.title = muted ? "Microphone muted; click to unmute" : "Listening; click to mute";
        this.touch();
      } else void this.toggleRecording();
    });
    this.logBtn.addEventListener("click", () => this.toggleLog());
    this.input.addEventListener("input", () => this.touch());
    this.input.addEventListener("keydown", (e) => {
      this.touch();
      if (e.key === "Enter") {
        e.preventDefault();
        void this.submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.hide();
      } else if (e.key === "ArrowUp" && !this.input.value) {
        e.preventDefault();
        this.toggleLog(true);
      }
      e.stopPropagation();
    });
    // Keep the buddy's grab handling from seeing presses on the strip or the log.
    for (const target of [this.el, this.logEl]) {
      for (const ev of ["pointerdown", "pointerup", "dblclick", "contextmenu"] as const) {
        target.addEventListener(ev, (e) => {
          this.touch();
          e.stopPropagation();
        });
      }
    }
  }

  /** Any interaction: push the idle timeout back. */
  touch() {
    clearTimeout(this.idleTimer);
    if (!this.open) return;
    this.idleTimer = window.setTimeout(() => {
      if (this.busy || this.recorder) this.touch();
      else this.hide();
    }, TALK_IDLE_MS);
  }

  show() {
    this.el.hidden = false;
    this.open = true;
    this.mic.hidden = !this.micEnabled;
    this.vuMeter.hidden = !this.micEnabled;
    if (this.onMicToggle) {
      this.mic.textContent = "🎤";
      this.mic.title = "Listening; click to mute";
    } else {
      this.mic.textContent = "🎤";
      this.mic.title = "Click to talk, click again when done";
    }
    this.onOpenChange?.(true);
    this.touch();
    setTimeout(() => this.input.focus(), 30);
  }

  /** Open the talk box pre-filled with a prompt (e.g. from an action chip). */
  openWith(prompt: string) {
    this.show();
    this.input.value = prompt;
    this.input.select();
  }

  hide() {
    clearTimeout(this.idleTimer);
    if (this.recorder) this.stopRecording(true);
    this.el.hidden = true;
    this.logEl.hidden = true;
    this.open = false;
    this.onOpenChange?.(false);
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  /** Remember a line for the history panel (memory only, this session). */
  remember(entry: TalkEntry) {
    this.log.push(entry);
    if (this.log.length > LOG_MAX) this.log.shift();
    if (!this.logEl.hidden) this.renderLog();
  }

  private toggleLog(show?: boolean) {
    const want = show ?? this.logEl.hidden;
    this.logEl.hidden = !want;
    if (want) this.renderLog();
  }

  private renderLog() {
    this.logEl.innerHTML = "";
    if (!this.log.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "Nothing said yet.";
      this.logEl.appendChild(p);
      return;
    }
    for (const e of this.log) {
      const p = document.createElement("p");
      p.className = e.who;
      p.textContent = e.text;
      this.logEl.appendChild(p);
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** Put text in the box (from transcription) and send it. */
  private async submit(text = this.input.value) {
    const line = text.trim();
    if (!line || this.busy || !this.onSend) return;
    this.input.value = line;
    this.input.title = `You: ${line}`;
    this.setBusy(true);
    this.remember({ who: "you", text: line });
    try {
      await this.onSend(line);
      this.input.value = "";
    } finally {
      this.setBusy(false);
      this.touch();
      if (this.open) this.input.focus();
    }
  }

  private setBusy(b: boolean) {
    this.busy = b;
    this.el.classList.toggle("busy", b);
    this.input.disabled = b;
    this.send.disabled = b;
  }

  updateMicLevel(level: number) {
    const bars = Array.from(this.vuMeter.children) as HTMLElement[];
    if (level <= 0.01) {
      this.vuMeter.classList.remove("active");
      for (const bar of bars) bar.style.height = "20%";
      return;
    }
    this.vuMeter.classList.add("active");
    bars.forEach((bar, i) => {
      const mult = i % 2 === 0 ? 1.0 : 0.65;
      const h = Math.min(100, Math.max(15, Math.round(level * 100 * mult)));
      bar.style.height = `${h}%`;
    });
  }

  /**
   * Sit just above the head, the way the bubble does. Returns the top edge taken, so the caller
   * can put the bubble above that instead of through it. `headY` is the top of his head in CSS
   * pixels; the strip keeps its own full width.
   */
  place(headY: number): number {
    if (!this.open) return headY;
    const top = Math.max(2, headY - this.el.offsetHeight - 8);
    this.el.style.top = `${top}px`;
    return top;
  }

  /** Height in CSS px while showing, else 0; the camera reserves this much above the head. */
  stripHeight(): number {
    return this.open ? this.el.offsetHeight + 8 : 0;
  }

  /** True while the microphone is open. */
  get recording(): boolean {
    return this.recorder !== null;
  }

  /** Open the microphone without the button, for the push-to-talk hotkey. */
  async startListening() {
    if (!this.recorder) await this.toggleRecording();
  }

  /** Close it again and send what was said. */
  stopListening() {
    if (this.recorder) this.stopRecording(false);
  }

  /** Every level the meter measured during this recording, for heardSpeech to judge. */
  private levels: number[] = [];

  private async toggleRecording() {
    this.touch();
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
    this.onHeard?.("");
    this.recorder = rec;
    this.mic.classList.add("rec");
    this.input.placeholder = "Listening… click the mic again when done";

    this.levels = [];
    try {
      this.sttCtx = new AudioContext();
      const src = this.sttCtx.createMediaStreamSource(this.stream);
      const an = this.sttCtx.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      clearInterval(this.sttTimer);
      this.sttTimer = window.setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        this.updateMicLevel(level);
        this.levels.push(level);
      }, 50);
    } catch {
      // Audio level fallback
    }

    // Nobody talks for more than half a minute to a desk toy.
    setTimeout(() => {
      if (this.recorder === rec) this.stopRecording(false);
    }, 30_000);
  }

  private stopRecording(discard: boolean) {
    if (discard) this.onHeard?.(null);
    const rec = this.recorder;
    clearInterval(this.sttTimer);
    try {
      this.sttCtx?.close();
    } catch {
      // closed
    }
    this.sttCtx = null;
    this.updateMicLevel(0);
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
    if (blob.size < 2000) {
      this.onHeard?.(null);
      return;
    }
    // Nothing was said: no point paying to transcribe a quiet room, and every point in not
    // handing the model whatever Whisper decides the silence sounded like.
    if (!heardSpeech(this.levels)) {
      this.onHeard?.(null);
      this.onStatus?.("I didn't hear anything.");
      return;
    }
    this.setBusy(true);
    this.input.placeholder = "Transcribing…";
    try {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const text = await invoke<string>("transcribe", { audio: Array.from(buf), mime: mime.split(";")[0] });
      this.setBusy(false);
      if (text) {
        this.input.value = text;
        this.onHeard?.(text);
        await this.submit(text);
      } else {
        // Cleared first: a status line is lower priority than the heard line and would be
        // suppressed by it, leaving the microphone bubble up with nothing to replace it.
        this.onHeard?.(null);
        this.onStatus?.("Didn't catch that.");
      }
    } catch (err) {
      this.setBusy(false);
      this.onHeard?.(null);
      this.onStatus?.(String(err).slice(0, 80));
    } finally {
      this.input.placeholder = "Say something… (Esc closes)";
      this.touch();
    }
  }
}

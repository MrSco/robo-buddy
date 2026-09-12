/**
 * Live voice: one GPT-Live session over WebRTC that listens, thinks and speaks. The Rust side
 * holds the key and exchanges the SDP; this class owns the microphone, the remote audio, the
 * event channel, the transcripts and the tool calls. It replaces the speech-to-text, chat and
 * text-to-speech chain when the user picks it as the talk engine.
 */
import { invoke } from "@tauri-apps/api/core";

export interface LiveConfig {
  /** Prompt for the voice model itself: who he is and how to hold the conversation. */
  instructions: string;
  /** The backend that reasons and runs tools on his behalf. */
  backend: { model: string; instructions: string; tools: unknown[] };
  /** Optional voice name; left out when blank so the server's default applies. */
  voice?: string;
}

export interface ToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export type LiveState = "off" | "connecting" | "on" | "closing";

/** A gap this long in a transcript ends the utterance. */
const USER_GAP_MS = 1200;
const HIM_GAP_MS = 1500;

export class LiveVoice {
  state: LiveState = "off";
  muted = false;
  /** Cumulative voice seconds the server has reported for this session. */
  serverSeconds = 0;
  /** Why the last session ended, for the status line. */
  lastReason = "-";
  onUser?: (text: string, final: boolean) => void;
  onHim?: (text: string, final: boolean) => void;
  onTool?: (call: ToolCall) => Promise<string>;
  onStatus?: (text: string) => void;
  onClosed?: (reason: string) => void;
  onMicLevel?: (level: number) => void;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micLevelTimer = 0;
  private levelTimer = 0;
  private lastLoud = -Infinity;
  private userText = "";
  private userTimer = 0;
  private himText = "";
  private himTimer = 0;
  private startedAt = 0;
  private counted = 0;
  private handled = new Set<string>();
  private closeWaiter: (() => void) | null = null;

  constructor() {
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.hidden = true;
    document.body.appendChild(this.audio);
  }

  /** True while his voice is coming out of the speakers (last quarter second). */
  get speaking(): boolean {
    return performance.now() - this.lastLoud < 250;
  }

  /** Seconds this session has run, from the server when it says, else the clock. */
  get seconds(): number {
    if (this.state === "off" || this.state === "connecting" || !this.startedAt) return 0;
    return Math.max(this.serverSeconds, (performance.now() - this.startedAt) / 1000);
  }

  async connect(cfg: LiveConfig) {
    if (this.state !== "off") return;
    this.state = "connecting";
    this.userText = this.himText = "";
    this.handled.clear();
    this.serverSeconds = 0;
    this.counted = 0;
    this.startedAt = 0;
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.watchMic(this.mic);
      const pc = new RTCPeerConnection();
      this.pc = pc;
      pc.ontrack = (e) => {
        this.audio.srcObject = e.streams[0];
        this.watchLevel(e.streams[0]);
      };
      for (const t of this.mic.getAudioTracks()) pc.addTrack(t, this.mic);
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.addEventListener("message", (e) => this.onEvent(String(e.data)));
      dc.addEventListener("close", () => this.finish("connection_lost"));
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") this.finish("connection_lost");
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.gatherIce(pc, 1500);
      const session: Record<string, unknown> = {
        model: "gpt-live-1",
        instructions: cfg.instructions,
        delegation: {
          type: "responses",
          responses: { model: cfg.backend.model, instructions: cfg.backend.instructions, tools: cfg.backend.tools, tool_choice: "auto" },
        },
      };
      if (cfg.voice) session.audio = { output: { voice: cfg.voice } };
      const answer = await invoke<string>("live_connect", { sdp: pc.localDescription?.sdp ?? offer.sdp, session });
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      this.startedAt = performance.now();
      this.state = "on";
      if (this.muted) this.applyMute();
    } catch (err) {
      this.cleanup();
      this.state = "off";
      throw err;
    }
  }

  /** Typed text goes in as a user message; the model answers out loud as usual. */
  sendText(text: string) {
    if (this.state !== "on" || !this.dc) return false;
    this.send({ type: "response.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.send({ type: "response.create" });
    return true;
  }

  /** Mute the microphone: the tracks stop locally and the server is told too. */
  setMuted(on: boolean) {
    this.muted = on;
    this.applyMute();
  }

  private applyMute() {
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !this.muted;
    if (this.state === "on") this.send({ type: this.muted ? "session.input_audio.mute" : "session.input_audio.unmute" });
  }

  /** Ask the server to end the session, wait briefly for its closing event, then tear down. */
  async close() {
    if (this.state === "off" || this.state === "closing") return;
    this.state = "closing";
    this.send({ type: "session.close" });
    await new Promise<void>((resolve) => {
      this.closeWaiter = resolve;
      setTimeout(resolve, 1500);
    });
    this.closeWaiter = null;
    this.finish("close_requested");
  }

  private send(event: Record<string, unknown>) {
    try {
      if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(event));
    } catch {
      // A closing channel; the finish path handles it.
    }
  }

  private gatherIce(pc: RTCPeerConnection, maxMs: number) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === "complete") done();
      };
      pc.addEventListener("icegatheringstatechange", check);
      setTimeout(done, maxMs);
    });
  }

  private onEvent(raw: string) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    const type = String(ev.type ?? "");
    switch (type) {
      case "session.started":
        this.onStatus?.("Listening…");
        return;
      case "session.closed": {
        const reason = String(ev.reason ?? "closed");
        this.closeWaiter?.();
        this.finish(reason);
        return;
      }
      case "session.input_transcript.delta":
        this.userText += String(ev.delta ?? "");
        this.onUser?.(this.userText, false);
        clearTimeout(this.userTimer);
        this.userTimer = window.setTimeout(() => {
          const t = this.userText.trim();
          this.userText = "";
          if (t) this.onUser?.(t, true);
        }, USER_GAP_MS);
        return;
      case "session.output_transcript.delta":
        this.himText += String(ev.delta ?? "");
        this.onHim?.(this.himText, false);
        clearTimeout(this.himTimer);
        this.himTimer = window.setTimeout(() => {
          const t = this.himText.trim();
          this.himText = "";
          if (t) this.onHim?.(t, true);
        }, HIM_GAP_MS);
        return;
      case "session.usage.updated": {
        const secs = findNumber(ev.usage ?? ev, /second|duration/i);
        if (secs !== null) this.serverSeconds = secs;
        return;
      }
      case "error": {
        const msg = findString(ev, /message/i) ?? raw.slice(0, 120);
        this.onStatus?.(`Live: ${msg}`);
        return;
      }
    }
    // Finished function calls arrive nested in output-item events; deltas are ignored.
    if (/output_item\.done$|response\.done$/.test(type)) {
      for (const call of findCalls(ev)) void this.runTool(call);
    }
  }

  private async runTool(call: ToolCall) {
    if (this.handled.has(call.callId)) return;
    this.handled.add(call.callId);
    let output = "Nothing happened.";
    try {
      output = (await this.onTool?.(call)) ?? output;
    } catch (err) {
      output = `Failed: ${String(err).slice(0, 120)}`;
    }
    this.send({ type: "response.item.create", item: { type: "function_call_output", call_id: call.callId, output } });
    this.send({ type: "response.create" });
  }

  private watchLevel(stream: MediaStream) {
    try {
      this.ctx ??= new AudioContext();
      const src = this.ctx.createMediaStreamSource(stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.analyser = an;
      const buf = new Uint8Array(an.fftSize);
      clearInterval(this.levelTimer);
      this.levelTimer = window.setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        if (Math.sqrt(sum / buf.length) > 0.03) this.lastLoud = performance.now();
      }, 50);
    } catch {
      // No level meter: he just will not nod along.
    }
  }

  private watchMic(stream: MediaStream) {
    try {
      this.ctx ??= new AudioContext();
      const src = this.ctx.createMediaStreamSource(stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.micAnalyser = an;
      const buf = new Uint8Array(an.fftSize);
      clearInterval(this.micLevelTimer);
      this.micLevelTimer = window.setInterval(() => {
        if (!this.micAnalyser) return;
        this.micAnalyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const level = Math.min(1, rms * 4);
        this.onMicLevel?.(level);
      }, 50);
    } catch {
      // Audio level meter fallback
    }
  }

  private finish(reason: string) {
    if (this.state === "off") return;
    const secs = this.seconds;
    const add = Math.max(0, secs - this.counted);
    this.counted = secs;
    if (add > 0) void invoke("live_add_seconds", { seconds: add }).catch(() => {});
    this.lastReason = reason;
    this.cleanup();
    this.state = "off";
    this.onClosed?.(reason);
  }

  private cleanup() {
    clearTimeout(this.userTimer);
    clearTimeout(this.himTimer);
    clearInterval(this.levelTimer);
    clearInterval(this.micLevelTimer);
    this.analyser = null;
    this.micAnalyser = null;
    this.onMicLevel?.(0);
    try {
      this.dc?.close();
    } catch {
      /* already closed */
    }
    try {
      this.pc?.close();
    } catch {
      /* already closed */
    }
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.dc = null;
    this.pc = null;
    this.mic = null;
    this.audio.srcObject = null;
    this.lastLoud = -Infinity;
  }
}

/** Every finished function call anywhere inside an event. */
function findCalls(v: unknown, out: ToolCall[] = [], depth = 0): ToolCall[] {
  if (!v || typeof v !== "object" || depth > 6) return out;
  if (Array.isArray(v)) {
    for (const x of v) findCalls(x, out, depth + 1);
    return out;
  }
  const o = v as Record<string, unknown>;
  if (o.type === "function_call" && typeof o.call_id === "string" && typeof o.name === "string") {
    let args: Record<string, unknown> = {};
    try {
      args = typeof o.arguments === "string" ? JSON.parse(o.arguments || "{}") : ((o.arguments as Record<string, unknown>) ?? {});
    } catch {
      args = {};
    }
    out.push({ callId: o.call_id, name: o.name, args });
    return out;
  }
  for (const k of Object.keys(o)) findCalls(o[k], out, depth + 1);
  return out;
}

function findNumber(v: unknown, key: RegExp, depth = 0): number | null {
  if (!v || typeof v !== "object" || depth > 4) return null;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (key.test(k) && typeof o[k] === "number") return o[k] as number;
  for (const k of Object.keys(o)) {
    const r = findNumber(o[k], key, depth + 1);
    if (r !== null) return r;
  }
  return null;
}

function findString(v: unknown, key: RegExp, depth = 0): string | null {
  if (!v || typeof v !== "object" || depth > 4) return null;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (key.test(k) && typeof o[k] === "string") return o[k] as string;
  for (const k of Object.keys(o)) {
    const r = findString(o[k], key, depth + 1);
    if (r !== null) return r;
  }
  return null;
}

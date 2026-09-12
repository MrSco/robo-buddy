/**
 * Things you can tell him to do in chat. Two routes feed the same commands: a quick local
 * parse of what you typed (instant, no model needed) and an action tag the model may append
 * to its reply (`<do:dance name="Chicken Dance">`), which is stripped before the bubble.
 */
export type Command =
  | { kind: "dance"; name?: string; seconds?: number }
  | { kind: "stop" }
  | { kind: "sleep" }
  | { kind: "wake" }
  | { kind: "come" }
  | { kind: "jump" }
  | { kind: "climb" }
  | { kind: "walk"; dir: -1 | 1 }
  | { kind: "quiet"; minutes: number }
  | { kind: "play"; clip: string };

const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

/** Best clip whose name is mentioned in the text ("do the chicken dance" -> Chicken_Dance). */
export function matchName(text: string, names: string[]): string | undefined {
  const t = norm(text);
  let best: { name: string; len: number } | null = null;
  for (const n of names) {
    const key = norm(n);
    // Generic names ("dance", "idle") would match every sentence; only distinctive names count.
    if (!key || ["procedural", "dance", "idle", "walk", "hit"].includes(key)) continue;
    const words = key.split(" ");
    // Full name, or any single distinctive word of it (not "dance", "idle", "loop", "hip hop").
    const hits = [key, ...words.filter((w) => w.length > 3 && !["dance", "idle", "loop", "hop"].includes(w))];
    for (const h of hits) {
      if (new RegExp(`\\b${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t) && (!best || h.length > best.len)) best = { name: n, len: h.length };
    }
  }
  return best?.name;
}

/** What the typed text asks him to do, if anything. `dances` and `clips` are pack clip names. */
export function parseCommand(text: string, dances: string[], clips: string[]): Command | null {
  const t = norm(text);
  if (/\b(stop|enough|quit|freeze|cut it out|knock it off|hold still|stand still)\b/.test(t) && !/\bdon'?t stop\b/.test(t)) return { kind: "stop" };
  if (/\b(shut up|be quiet|quiet|hush|silence|pipe down|zip it)\b/.test(t)) {
    const m = t.match(/(\d+)\s*(min|minute|hour)/);
    const minutes = m ? Number(m[1]) * (m[2].startsWith("hour") ? 60 : 1) : 10;
    return { kind: "quiet", minutes };
  }
  if (/\b(wake up|wakey|get up|rise and shine)\b/.test(t)) return { kind: "wake" };
  if (/\b(go to sleep|sleep|take a nap|nap|lie down|rest)\b/.test(t)) return { kind: "sleep" };
  if (/\b(come here|come over|over here|come to me|come closer|get over here)\b/.test(t)) return { kind: "come" };
  const namedDance = matchName(text, dances);
  if (namedDance || /\b(dance|bust a move|groove|boogie|shake it|show me your moves)\b/.test(t)) {
    const m = t.match(/(\d+)\s*(s|sec|second|seconds|min|minute|minutes)\b/);
    let seconds = m ? Number(m[1]) * (m[2].startsWith("min") ? 60 : 1) : undefined;
    // "half a minute" contains "a minute", so the narrower phrase has to be tested first.
    if (!seconds && /\bhalf a minute\b/.test(t)) seconds = 30;
    if (!seconds && /\b(a|one) minute\b/.test(t)) seconds = 60;
    return { kind: "dance", name: namedDance, seconds };
  }
  if (/\b(climb)\b/.test(t)) return { kind: "climb" };
  if (/\b(jump|hop)\b/.test(t)) return { kind: "jump" };
  const w = t.match(/\b(walk|go|move|step|head)\b.*\b(left|right)\b/);
  if (w) return { kind: "walk", dir: w[2] === "left" ? -1 : 1 };
  if (/\b(play|do|show|perform)\b/.test(t)) {
    const clip = matchName(text, clips);
    if (clip) return { kind: "play", clip };
  }
  return null;
}

/** Pull a `<do:...>` tag out of a model reply. Returns the clean text and the command, if any. */
export function extractTag(reply: string, dances: string[]): { text: string; command: Command | null } {
  const m = reply.match(/<do:([a-z]+)([^>]*)>/i);
  if (!m) return { text: reply, command: null };
  const text = reply.replace(m[0], "").replace(/\s{2,}/g, " ").trim();
  const kind = m[1].toLowerCase();
  const attrs = m[2];
  const attr = (k: string) => attrs.match(new RegExp(`${k}\\s*=\\s*"([^"]*)"`, "i"))?.[1] ?? attrs.match(new RegExp(`${k}\\s*=\\s*([^\\s>]+)`, "i"))?.[1];
  let command: Command | null = null;
  switch (kind) {
    case "dance":
      command = { kind: "dance", name: attr("name") ? matchName(attr("name")!, dances) : undefined, seconds: attr("seconds") ? Number(attr("seconds")) : undefined };
      break;
    case "stop":
    case "sleep":
    case "wake":
    case "come":
    case "jump":
    case "climb":
      command = { kind };
      break;
    case "walk":
      command = { kind: "walk", dir: (attr("dir") ?? "right").toLowerCase().startsWith("l") ? -1 : 1 };
      break;
    case "quiet":
      command = { kind: "quiet", minutes: Number(attr("minutes") ?? 10) || 10 };
      break;
  }
  return { text, command };
}

/** Tool definitions (OpenAI function format) for a backend that acts through tool calls. */
export function toolDefinitions(dances: string[]): unknown[] {
  const list = dances.filter((d) => d !== "procedural").map(norm).slice(0, 24);
  const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
    type: "function",
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
  });
  return [
    fn("dance", "Start dancing. Only when the user asks for a dance.", {
      name: { type: "string", description: `Dance name, one of: ${list.join(", ")}. Omit for a random one.` },
      seconds: { type: "number", description: "How long to dance, in seconds (default 45)." },
    }),
    fn("stop", "Stop whatever you are doing (dancing, walking) and stand still."),
    fn("sleep", "Go to sleep / take a nap."),
    fn("wake", "Wake up."),
    fn("come", "Walk over to the user's mouse cursor."),
    fn("jump", "Jump once."),
    fn("climb", "Climb up onto a nearby window."),
    fn("walk", "Walk a little way to the left or right.", { dir: { type: "string", enum: ["left", "right"] } }, ["dir"]),
    fn("quiet", "Stay quiet (no idle remarks) for a while.", { minutes: { type: "number", description: "Minutes of quiet (default 10)." } }),
  ];
}

/** Turn a tool call from the model into a command, or null if it is not one of ours. */
export function commandFromTool(name: string, args: Record<string, unknown>, dances: string[]): Command | null {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  const num = (k: string) => (typeof args[k] === "number" ? (args[k] as number) : undefined);
  switch (name) {
    case "dance":
      return { kind: "dance", name: str("name") ? matchName(str("name")!, dances) : undefined, seconds: num("seconds") };
    case "stop":
    case "sleep":
    case "wake":
    case "come":
    case "jump":
    case "climb":
      return { kind: name };
    case "walk":
      return { kind: "walk", dir: (str("dir") ?? "right").toLowerCase().startsWith("l") ? -1 : 1 };
    case "quiet":
      return { kind: "quiet", minutes: num("minutes") || 10 };
  }
  return null;
}

/** The line the system prompt gets, so the model knows what it can do and how to say so. */
export function abilitiesPrompt(dances: string[]): string {
  const list = dances.filter((d) => d !== "procedural").map(norm).slice(0, 24).join(", ");
  return (
    `You can also act. When the user asks you to do one of these, end your reply with exactly one tag: ` +
    `<do:dance name="..."> (dances: ${list}; leave the name out for a random one), <do:stop>, <do:sleep>, <do:wake>, ` +
    `<do:come> (come to their cursor), <do:jump>, <do:climb> (climb a nearby window), <do:walk dir="left|right">, ` +
    `<do:quiet minutes="10">. Never add a tag unless they asked for the action.`
  );
}

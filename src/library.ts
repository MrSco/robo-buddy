import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./input";
import type { Manifest } from "./packs";

/**
 * The shared animation library: bundled clips (retargeted at load onto any rig) plus
 * clips the user imported. Roles decide where a clip is used; the manifest's own lists
 * are the defaults and user roles from settings extend or override them.
 */
export type Role = "idle" | "fidget" | "dance" | "poke" | "held" | "fall" | "jump" | "walk" | "run" | "off";
export const ROLES: Role[] = ["idle", "fidget", "dance", "poke", "held", "fall", "jump", "walk", "run", "off"];

export interface LibraryClip {
  /** Clip key used in manifests and roles. */
  name: string;
  /** URL the loader can fetch. */
  url: string;
  /** Where it came from. */
  source: "ual" | "mixamo" | "user";
  duration?: number;
  /** File name for clips in the user's folder (deletable); bundled clips have none. */
  file?: string;
  /** Role implied by the bundled manifests, before user overrides. */
  defaultRole: Role;
}

interface IndexEntry {
  name: string;
  file: string;
  duration: number;
  loop: boolean;
}

interface UserClip {
  name: string;
  file: string;
  dir: string;
}

let cached: Promise<LibraryClip[]> | null = null;

async function readIndex(dir: string, source: "ual" | "mixamo"): Promise<LibraryClip[]> {
  try {
    const entries = (await (await fetch(`/clips/${dir}/index.json`)).json()) as IndexEntry[];
    return entries.map((e) => ({ name: e.name, url: `/clips/${dir}/${e.file}`, source, duration: e.duration, defaultRole: "off" }));
  } catch {
    return [];
  }
}

/** All library clips. Default roles come from the reference manifest (Rocco's). */
export async function listLibrary(reference?: Manifest): Promise<LibraryClip[]> {
  if (!cached) {
    cached = (async () => {
      const bundled = [...(await readIndex("ual", "ual")), ...(await readIndex("mixamo", "mixamo"))];
      const users: LibraryClip[] = IN_TAURI
        ? (await invoke<UserClip[]>("list_user_clips")).map((u) => ({
            name: u.name,
            url: convertFileSrc(`${u.dir}\\${u.file}`),
            source: "user" as const,
            file: u.file,
            defaultRole: "off" as const,
          }))
        : [];
      return [...bundled, ...users];
    })();
  }
  const clips = await cached;
  if (reference) {
    // Map manifest clip keys (which point at files) back to library names.
    const fileToKey = new Map<string, string>();
    for (const [key, file] of Object.entries(reference.clips ?? {})) fileToKey.set(file, key);
    const roleOfKey = new Map<string, Role>();
    for (const v of reference.idleVariants ?? []) roleOfKey.set(v, "idle");
    for (const f of reference.fidgets ?? []) for (const c of Array.isArray(f) ? f : [f]) roleOfKey.set(c, "fidget");
    for (const d of reference.dances ?? []) roleOfKey.set(typeof d === "string" ? d : d.clip, "dance");
    for (const c of reference.states.poked?.clips ?? [reference.states.poked?.clip ?? ""]) if (c) roleOfKey.set(c, "poke");
    if (reference.states.dragged) roleOfKey.set(reference.states.dragged.clip, "held");
    if (reference.states.fall) roleOfKey.set(reference.states.fall.clip, "fall");
    if (reference.states.jump) roleOfKey.set(reference.states.jump.clip, "jump");
    if (reference.states.walk) roleOfKey.set(reference.states.walk.clip, "walk");
    if (reference.states.run) roleOfKey.set(reference.states.run.clip, "run");
    if (reference.states.idle) roleOfKey.set(reference.states.idle.clip, "idle");
    for (const c of clips) {
      const key = fileToKey.get(c.url);
      c.defaultRole = (key ? roleOfKey.get(key) : undefined) ?? "off";
    }
  }
  return clips;
}

export function invalidateLibrary() {
  cached = null;
}

/**
 * The manifest a 3D pack actually runs with. An imported model brings no animation of its
 * own, so it borrows the bundled reference character's states, idle variants, fidgets and
 * dances (all of which live in the shared clip library); then the library is applied with
 * the user's role overrides. Bundled packs keep their own manifest as the base.
 */
export function effectiveManifest(base: Manifest, bundled: boolean, reference: Manifest | undefined, library: LibraryClip[], roles: Record<string, string>): Manifest {
  if (base.renderer !== "3d") return base;
  let m = base;
  if (reference && !bundled) {
    m = {
      ...base,
      clips: { ...(reference.clips ?? {}), ...(base.clips ?? {}) },
      states: { ...reference.states, ...base.states },
      idleVariants: base.idleVariants ?? reference.idleVariants,
      fidgets: base.fidgets ?? reference.fidgets,
      dances: base.dances ?? reference.dances,
    };
  }
  return applyLibrary(m, library, roles);
}

/**
 * Apply the library to a pack's manifest: every library clip becomes available under its
 * library name, and user roles add clips to the behaviour lists. Returns a new manifest.
 */
export function applyLibrary(manifest: Manifest, library: LibraryClip[], roles: Record<string, string>): Manifest {
  const m: Manifest = JSON.parse(JSON.stringify(manifest));
  m.clips = { ...(m.clips ?? {}) };
  const keyByUrl = new Map<string, string>();
  for (const [k, f] of Object.entries(m.clips)) keyByUrl.set(f, k);
  const keyOf = (c: LibraryClip) => {
    const existing = keyByUrl.get(c.url);
    if (existing) return existing;
    m.clips![c.name] = c.url;
    keyByUrl.set(c.url, c.name);
    return c.name;
  };
  const idle = new Set(m.idleVariants ?? []);
  const fidgets = (m.fidgets ?? []).slice();
  const fidgetKeys = new Set(fidgets.map((f) => (Array.isArray(f) ? f.join("+") : f)));
  const dances = (m.dances ?? []).slice();
  const danceKeys = new Set(dances.map((d) => (typeof d === "string" ? d : d.clip)));
  const pokes = new Set(m.states.poked?.clips ?? (m.states.poked ? [m.states.poked.clip] : []));

  for (const c of library) {
    // Every library clip is registered so any pack can reference it by name.
    const key = keyOf(c);
    const role = (roles[c.name] as Role | undefined) ?? (c.source === "user" ? "off" : undefined);
    if (!role) continue; // bundled clip with no override keeps the manifest's own placement
    if (role === "off") {
      idle.delete(key);
      danceKeys.delete(key);
      pokes.delete(key);
      const fi = fidgets.findIndex((f) => (Array.isArray(f) ? f.join("+") : f) === key);
      if (fi >= 0) fidgets.splice(fi, 1);
      const di = dances.findIndex((d) => (typeof d === "string" ? d : d.clip) === key);
      if (di >= 0) dances.splice(di, 1);
      continue;
    }
    if (role === "idle") idle.add(key);
    if (role === "fidget" && !fidgetKeys.has(key)) fidgets.push(key);
    if (role === "dance" && !danceKeys.has(key)) dances.splice(Math.max(0, dances.length - 1), 0, key);
    if (role === "poke") pokes.add(key);
    if (role === "held") m.states.dragged = { clip: key, loop: true };
    if (role === "fall") m.states.fall = { clip: key, loop: true };
    // The take-off only; the leap off a ledge stays the pack's own, since a clip that reads as
    // a hop upward rarely reads as a dive off the side.
    if (role === "jump") m.states.jump = { clip: key, loop: false };
    if (role === "walk") m.states.walk = { ...(m.states.walk ?? { speed: 110 }), clip: key, loop: true };
    // A run assigned by hand keeps the pack's own pace if it has one; otherwise a jog's worth.
    if (role === "run") m.states.run = { ...(m.states.run ?? { speed: 300, naturalMps: 3.5 }), clip: key, loop: true };
  }
  m.idleVariants = [...idle];
  m.fidgets = fidgets;
  m.dances = dances;
  if (pokes.size) m.states.poked = { ...(m.states.poked ?? { clip: "", loop: false }), clip: [...pokes][0], clips: [...pokes], loop: false };
  return m;
}

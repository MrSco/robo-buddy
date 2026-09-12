import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, lightingFor, type Settings } from "./settings-store";

/**
 * Settings cross the language boundary: the frontend sends the whole object, Rust deserialises
 * it into its own struct and writes that back to disk. A field Rust does not know is dropped on
 * the next save, which is silent and looks like "the setting will not stick" — exactly what
 * happened to the Lighting slider. These tests keep the two definitions in step.
 */
const RUST = readFileSync(new URL("../src-tauri/src/settings.rs", import.meta.url), "utf8");

/** Field names of the Rust `Settings` struct, as camelCase (serde renames them that way). */
function rustSettingsFields(): string[] {
  const start = RUST.indexOf("pub struct Settings {");
  expect(start, "the Settings struct should exist in settings.rs").toBeGreaterThan(-1);
  const body = RUST.slice(start, RUST.indexOf("\n}", start));
  const fields: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*pub\s+([a-z0-9_]+)\s*:/);
    if (m) fields.push(m[1].replace(/_([a-z0-9])/g, (_m: string, c: string) => c.toUpperCase()));
  }
  return fields;
}

describe("the settings contract between TypeScript and Rust", () => {
  it("declares the same camelCase rename on the Rust struct", () => {
    // Without this the field names would not line up at all.
    expect(RUST).toContain('rename_all = "camelCase"');
  });

  it("keeps serde(default) so an older settings file still loads", () => {
    expect(RUST).toMatch(/#\[serde\(default[,)]/);
  });

  it("has a Rust field for every setting the frontend sends", () => {
    const rust = new Set(rustSettingsFields());
    const missing = Object.keys(DEFAULT_SETTINGS).filter((k) => !rust.has(k));
    expect(
      missing,
      `these settings would be dropped on the next save because src-tauri/src/settings.rs has no field for them: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("has a frontend default for every field Rust carries", () => {
    const ts = new Set(Object.keys(DEFAULT_SETTINGS));
    const missing = rustSettingsFields().filter((k) => !ts.has(k));
    expect(missing, `Rust carries settings the frontend never sets: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("lightingFor", () => {
  const base: Settings = { ...DEFAULT_SETTINGS, lighting: 1.2, lightingByCharacter: { "t-800": 2.4, rocco: 0.8 } };

  it("gives a character its own value", () => {
    expect(lightingFor(base, "t-800")).toBe(2.4);
    expect(lightingFor(base, "rocco")).toBe(0.8);
  });

  it("falls back to the global value for a character with no entry", () => {
    expect(lightingFor(base, "mannequin")).toBe(1.2);
  });

  it("falls back to 1 when nothing is set", () => {
    expect(lightingFor({ ...DEFAULT_SETTINGS, lightingByCharacter: {} }, "anything")).toBe(1);
  });

  it("survives a settings object written before the field existed", () => {
    const old = { ...DEFAULT_SETTINGS } as Settings;
    delete (old as Partial<Settings>).lightingByCharacter;
    expect(() => lightingFor(old, "rocco")).not.toThrow();
    expect(lightingFor(old, "rocco")).toBe(DEFAULT_SETTINGS.lighting);
  });
});

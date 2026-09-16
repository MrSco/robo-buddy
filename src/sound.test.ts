import { describe, expect, it, beforeEach } from "vitest";
import { DEFAULT_SOUNDS, Sounds, type SoundEvent } from "./sound";
import type { Manifest, PackRef } from "./packs";

describe("DEFAULT_SOUNDS", () => {
  it("defines multi-sample pools for all sound events", () => {
    const requiredEvents: SoundEvent[] = [
      "land",
      "bump",
      "bounce",
      "grab",
      "throw",
      "poked",
      "footstep",
      "jump",
      "wake",
      "sleep",
      "bubble",
      "greet",
    ];

    for (const evt of requiredEvents) {
      expect(DEFAULT_SOUNDS[evt]).toBeDefined();
      expect(Array.isArray(DEFAULT_SOUNDS[evt])).toBe(true);
      expect(DEFAULT_SOUNDS[evt].length).toBeGreaterThanOrEqual(2);
      for (const file of DEFAULT_SOUNDS[evt]) {
        expect(file).toMatch(/^\/sounds\/.*\.wav$/);
      }
    }
  });
});

describe("Sounds engine", () => {
  let sounds: Sounds;
  const mockPack: PackRef = { id: "test", name: "Test Buddy", base: "/characters/test/", bundled: true };

  beforeEach(() => {
    sounds = new Sounds();
  });

  it("initializes with sensible defaults", () => {
    expect(sounds.enabled).toBe(true);
    expect(sounds.volume).toBe(0.6);
    expect(sounds.footstepsEnabled).toBe(true);
    expect(sounds.last).toBe("-");
  });

  it("tracks recent playback events in history", () => {
    sounds.play("poked");
    expect(sounds.last).toBe("poked");

    sounds.play("jump");
    sounds.play("land");
    expect(sounds.last).toBe("poked>jump>land");

    sounds.play("bump");
    sounds.play("footstep");
    // History retains last 4
    expect(sounds.last).toBe("jump>land>bump>footstep");
  });

  it("suppresses playback when disabled", () => {
    sounds.enabled = false;
    sounds.play("land");
    expect(sounds.last).toBe("-");
  });

  it("suppresses footstep events when footsteps are disabled", () => {
    sounds.footstepsEnabled = false;
    sounds.play("footstep");
    expect(sounds.last).toBe("-");

    // Other sounds still play
    sounds.play("land");
    expect(sounds.last).toBe("land");
  });

  it("handles pack custom sound overrides in load()", () => {
    const customManifest: Manifest = {
      name: "Cyborg",
      renderer: "3d",
      model: "cyborg.glb",
      states: {},
      reactions: {},
      version: 1,
      sounds: {
        land: "custom_thud.wav",
        bump: ["bump_a.wav", "bump_b.wav"],
      },
    };

    // Should load without throwing
    expect(() => sounds.load(mockPack, customManifest)).not.toThrow();
  });

  it("reports busy state when playing and respects graceMs", () => {
    expect(sounds.busy()).toBe(false);

    sounds.play("footstep");
    expect(sounds.busy(1000)).toBe(true);
    expect(sounds.busy(0)).toBe(true);

    // When sounds are disabled, busy() returns false
    sounds.enabled = false;
    expect(sounds.busy(1000)).toBe(false);
  });
});

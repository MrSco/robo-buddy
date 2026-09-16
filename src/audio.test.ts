import { describe, expect, it, beforeEach } from "vitest";
import { Music } from "./audio";

describe("Music engine hold gating", () => {
  let music: Music;

  beforeEach(() => {
    music = new Music();
    music.lockSeconds = 2.0; // short lock for test
  });

  it("locks onto steady tempo and starts dancing when hold is false", () => {
    expect(music.dancing).toBe(false);

    // Simulate steady 120 bpm audio over 3 seconds
    music.raw = {
      rms: 0.5,
      level: 0.6,
      bass: 0.5,
      mid: 0.5,
      treble: 0.5,
      onset: 0.8,
      beat: true,
      bpm: 120,
      silent: false,
    };

    music.update(0.1, 0.0);
    music.update(0.1, 0.1);
    music.update(0.1, 1.0);
    expect(music.dancing).toBe(false);

    // After lockSeconds (2.0s from stableSince=0.1, i.e. t >= 2.1s), dance starts
    music.update(0.1, 2.5);
    expect(music.dancing).toBe(true);
  });

  it("gates against starting a dance while hold is true", () => {
    music.hold = true;
    music.raw = {
      rms: 0.5,
      level: 0.6,
      bass: 0.5,
      mid: 0.5,
      treble: 0.5,
      onset: 0.8,
      beat: true,
      bpm: 120,
      silent: false,
    };

    // Simulate steady tempo for 5 seconds while hold is true
    music.update(0.1, 0.0);
    music.update(0.1, 0.1);
    music.update(0.1, 2.5);
    music.update(0.1, 5.0);
    expect(music.dancing).toBe(false);

    // Releasing hold should not instantly dance on next frame; it must re-acquire steady tempo
    music.hold = false;
    music.update(0.1, 5.1);
    expect(music.dancing).toBe(false);

    // Only after holding steady for lockSeconds after hold ends does it dance
    music.update(0.1, 7.5);
    expect(music.dancing).toBe(true);
  });

  it("preserves dance state during hold even if beat or level dips", () => {
    music.raw = {
      rms: 0.5,
      level: 0.6,
      bass: 0.5,
      mid: 0.5,
      treble: 0.5,
      onset: 0.8,
      beat: true,
      bpm: 120,
      silent: false,
    };

    music.update(0.1, 0.0);
    music.update(0.1, 0.1);
    music.update(0.1, 2.5);
    expect(music.dancing).toBe(true);

    // Buddy speaks or makes a sound effect (hold becomes true, raw dips or becomes silent)
    music.hold = true;
    music.raw = {
      rms: 0.0,
      level: 0.0,
      bass: 0.0,
      mid: 0.0,
      treble: 0.0,
      onset: 0.0,
      beat: false,
      bpm: 0,
      silent: true,
    };

    music.update(0.1, 3.0);
    music.update(0.1, 4.0);
    music.update(0.1, 6.0); // > 2 seconds without beat
    // He should NOT stop dancing because hold is active
    expect(music.dancing).toBe(true);

    // Once hold is released and silence persists > 2s, dance stops
    music.hold = false;
    music.update(0.1, 6.1);
    // At t=6.1, silence was during hold so belowSince starts at 6.1.
    // Dance stops once silence or belowSince > 2.0s
    music.update(0.1, 8.5);
    expect(music.dancing).toBe(false);
  });
});

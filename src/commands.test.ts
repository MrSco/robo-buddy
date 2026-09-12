import { describe, expect, it } from "vitest";
import { abilitiesPrompt, extractTag, matchName, parseCommand, toolDefinitions } from "./commands";

const DANCES = ["Chicken_Dance", "Robot_Hip_Hop", "YMCA", "Gangnam_Style", "dance", "procedural"];
const CLIPS = ["Getting_Up", "Texting", "Hanging_Idle", "idle", "walk"];

describe("matchName", () => {
  it("finds a dance named in a sentence", () => {
    expect(matchName("do the chicken dance", DANCES)).toBe("Chicken_Dance");
    expect(matchName("can you do gangnam style", DANCES)).toBe("Gangnam_Style");
  });

  it("matches one distinctive word of a longer name", () => {
    expect(matchName("do the robot", DANCES)).toBe("Robot_Hip_Hop");
  });

  it("ignores generic names so every sentence does not match", () => {
    // "dance" and "procedural" are in the list but must never be picked by name.
    expect(matchName("I love to dance", DANCES)).toBeUndefined();
    expect(matchName("nothing here", DANCES)).toBeUndefined();
  });

  it("does not match a word merely contained in another", () => {
    expect(matchName("ymcazzz", DANCES)).toBeUndefined();
  });
});

describe("parseCommand", () => {
  it("reads a plain dance request", () => {
    expect(parseCommand("dance for me", DANCES, CLIPS)).toEqual({ kind: "dance", name: undefined, seconds: undefined });
  });

  it("reads a named dance with a duration", () => {
    expect(parseCommand("do the chicken dance for 30 seconds", DANCES, CLIPS)).toEqual({
      kind: "dance",
      name: "Chicken_Dance",
      seconds: 30,
    });
  });

  it("understands minutes and spelled-out durations", () => {
    expect(parseCommand("dance for 2 minutes", DANCES, CLIPS)).toMatchObject({ kind: "dance", seconds: 120 });
    expect(parseCommand("dance for a minute", DANCES, CLIPS)).toMatchObject({ kind: "dance", seconds: 60 });
    expect(parseCommand("dance for half a minute", DANCES, CLIPS)).toMatchObject({ kind: "dance", seconds: 30 });
  });

  it("stops, but not when told not to stop", () => {
    expect(parseCommand("stop", DANCES, CLIPS)).toEqual({ kind: "stop" });
    expect(parseCommand("don't stop", DANCES, CLIPS)).not.toEqual({ kind: "stop" });
  });

  it("reads quiet with and without a duration", () => {
    expect(parseCommand("be quiet", DANCES, CLIPS)).toEqual({ kind: "quiet", minutes: 10 });
    expect(parseCommand("be quiet for 5 minutes", DANCES, CLIPS)).toEqual({ kind: "quiet", minutes: 5 });
    expect(parseCommand("quiet for 2 hours", DANCES, CLIPS)).toEqual({ kind: "quiet", minutes: 120 });
  });

  it("reads sleep, wake, come, climb and jump", () => {
    expect(parseCommand("go to sleep", DANCES, CLIPS)).toEqual({ kind: "sleep" });
    expect(parseCommand("wake up", DANCES, CLIPS)).toEqual({ kind: "wake" });
    expect(parseCommand("come here", DANCES, CLIPS)).toEqual({ kind: "come" });
    expect(parseCommand("climb that window", DANCES, CLIPS)).toEqual({ kind: "climb" });
    expect(parseCommand("jump", DANCES, CLIPS)).toEqual({ kind: "jump" });
  });

  it("reads a direction to walk", () => {
    expect(parseCommand("walk to the left", DANCES, CLIPS)).toEqual({ kind: "walk", dir: -1 });
    expect(parseCommand("go right a bit", DANCES, CLIPS)).toEqual({ kind: "walk", dir: 1 });
  });

  it("plays a named clip only when asked to play it", () => {
    expect(parseCommand("show me texting", DANCES, CLIPS)).toEqual({ kind: "play", clip: "Texting" });
    expect(parseCommand("texting", DANCES, CLIPS)).toBeNull();
  });

  it("returns null for ordinary conversation", () => {
    expect(parseCommand("how are you today", DANCES, CLIPS)).toBeNull();
    expect(parseCommand("", DANCES, CLIPS)).toBeNull();
  });
});

describe("extractTag", () => {
  it("pulls the tag out and leaves clean text", () => {
    const { text, command } = extractTag('Sure thing. <do:dance name="chicken dance">', DANCES);
    expect(text).toBe("Sure thing.");
    expect(command).toEqual({ kind: "dance", name: "Chicken_Dance", seconds: undefined });
  });

  it("handles tags with no attributes", () => {
    expect(extractTag("Okay. <do:stop>", DANCES).command).toEqual({ kind: "stop" });
    expect(extractTag("Night. <do:sleep>", DANCES).command).toEqual({ kind: "sleep" });
  });

  it("reads walk direction and quiet minutes", () => {
    expect(extractTag('<do:walk dir="left">', DANCES).command).toEqual({ kind: "walk", dir: -1 });
    expect(extractTag('<do:quiet minutes="25">', DANCES).command).toEqual({ kind: "quiet", minutes: 25 });
  });

  it("leaves an untagged reply alone", () => {
    const { text, command } = extractTag("Just talking here.", DANCES);
    expect(text).toBe("Just talking here.");
    expect(command).toBeNull();
  });

  it("ignores a tag it does not know", () => {
    expect(extractTag("<do:backflip>", DANCES).command).toBeNull();
  });
});

describe("tool definitions", () => {
  it("offers one function per ability, with a schema", () => {
    const tools = toolDefinitions(DANCES) as Array<{ type: string; name: string; parameters: unknown }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain("dance");
    expect(names).toContain("stop");
    expect(names).toContain("climb");
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(t.parameters).toBeTruthy();
    }
  });

  it("never offers the procedural placeholder as a dance name", () => {
    expect(JSON.stringify(toolDefinitions(DANCES))).not.toContain("procedural");
  });
});

describe("abilitiesPrompt", () => {
  it("lists the real dances and not the placeholder", () => {
    const p = abilitiesPrompt(DANCES);
    expect(p).toContain("chicken dance");
    expect(p).not.toContain("procedural");
  });
});

import { describe, expect, it } from "vitest";
import {
  ContextEngine,
  matchesRule,
  wildcardMatch,
  MIN_DWELL_SECONDS,
  MAX_IDLE_SECONDS,
  type ContextRule,
} from "./context";

describe("wildcardMatch", () => {
  it("matches full string case-insensitively", () => {
    expect(wildcardMatch("Code.exe", "code.exe")).toBe(true);
    expect(wildcardMatch("chrome.exe", "firefox.exe")).toBe(false);
  });

  it("matches wildcards at start and end", () => {
    expect(wildcardMatch("*YouTube*", "Rick Astley - Never Gonna Give You Up - YouTube - Google Chrome")).toBe(true);
    expect(wildcardMatch("*Stack Overflow*", "javascript - How do I exit vim? - Stack Overflow")).toBe(true);
    expect(wildcardMatch("*YouTube*", "Google Docs")).toBe(false);
  });

  it("handles universal wildcard", () => {
    expect(wildcardMatch("*", "anything")).toBe(true);
  });
});

describe("matchesRule", () => {
  const sampleRule: ContextRule = {
    id: "vscode",
    category: "coding",
    match: {
      process: ["Code.exe"],
      title: ["*Visual Studio Code*"],
    },
    animation: "Texting",
    lines: ["Writing code!"],
    chips: [{ label: "Explain", action: "ask" }],
  };

  it("matches when process and title meet criteria", () => {
    expect(matchesRule(sampleRule, "Code.exe", "main.ts - Visual Studio Code", 12)).toBe(true);
    expect(matchesRule(sampleRule, "chrome.exe", "Google Search", 12)).toBe(false);
  });

  it("matches timeRange rules", () => {
    const nightRule: ContextRule = {
      id: "night",
      category: "system_health",
      match: {
        timeRange: { startHour: 1, endHour: 5 },
      },
      lines: ["Sleep time"],
    };

    expect(matchesRule(nightRule, "Code.exe", "foo", 2)).toBe(true);
    expect(matchesRule(nightRule, "Code.exe", "foo", 14)).toBe(false);
  });
});

describe("ContextEngine", () => {
  const rules: ContextRule[] = [
    {
      id: "coding",
      category: "coding",
      match: { process: ["Code.exe"] },
      animation: "Texting",
      lines: ["Clean code!"],
      chips: [{ label: "Explain", action: "ask" }],
    },
  ];

  const defaultSettings = {
    enabled: true,
    chattiness: "chatty", // 150s cooldown
    blacklist: ["1Password.exe"],
  };

  it("does not trigger if disabled", () => {
    const engine = new ContextEngine(rules);
    const res = engine.evaluate(
      { process: "Code.exe", title: "app.ts", idleSeconds: 0, isSensitive: false },
      100,
      { ...defaultSettings, enabled: false },
    );
    expect(res).toBeNull();
  });

  it("does not trigger if sensitive window", () => {
    const engine = new ContextEngine(rules);
    const res = engine.evaluate(
      { process: "Code.exe", title: "app.ts", idleSeconds: 0, isSensitive: true },
      100,
      defaultSettings,
    );
    expect(res).toBeNull();
  });

  it("does not trigger if blacklisted process", () => {
    const engine = new ContextEngine(rules);
    const res = engine.evaluate(
      { process: "1Password.exe", title: "Vault", idleSeconds: 0, isSensitive: false },
      100,
      defaultSettings,
    );
    expect(res).toBeNull();
  });

  it("does not trigger if machine is idle (user AFK)", () => {
    const engine = new ContextEngine(rules);
    const res = engine.evaluate(
      { process: "Code.exe", title: "app.ts", idleSeconds: MAX_IDLE_SECONDS + 5, isSensitive: false },
      100,
      defaultSettings,
    );
    expect(res).toBeNull();
  });

  it("requires dwell time before triggering", () => {
    const engine = new ContextEngine(rules);
    // Initial arrival
    let res = engine.evaluate(
      { process: "Code.exe", title: "app.ts", idleSeconds: 0, isSensitive: false },
      100,
      defaultSettings,
    );
    expect(res).toBeNull();

    // 10 seconds later (below MIN_DWELL_SECONDS)
    res = engine.evaluate(
      { process: "Code.exe", title: "app.ts", idleSeconds: 0, isSensitive: false },
      110,
      defaultSettings,
    );
    expect(res).toBeNull();

    // After dwell threshold (e.g. 100 + 20s = 120s)
    res = engine.evaluate(
      { process: "Code.exe", title: "app.ts", idleSeconds: 0, isSensitive: false },
      100 + MIN_DWELL_SECONDS + 2,
      defaultSettings,
    );
    expect(res).not.toBeNull();
    expect(res?.category).toBe("coding");
    expect(res?.animation).toBe("Texting");
    expect(res?.line).toBe("Clean code!");
  });

  it("enforces cooldown between triggers", () => {
    const engine = new ContextEngine(rules);
    // First trigger
    engine.evaluate(
      { process: "Code.exe", title: "app.ts", idleSeconds: 0, isSensitive: false },
      100,
      defaultSettings,
    );
    const first = engine.evaluate(
      { process: "Code.exe", title: "app.ts", idleSeconds: 0, isSensitive: false },
      100 + MIN_DWELL_SECONDS + 1,
      defaultSettings,
    );
    expect(first).not.toBeNull();

    // Switch to another window immediately
    engine.evaluate(
      { process: "Code.exe", title: "other.ts", idleSeconds: 0, isSensitive: false },
      130,
      defaultSettings,
    );
    // Wait for dwell on the new window, but within cooldown (< 150s)
    const second = engine.evaluate(
      { process: "Code.exe", title: "other.ts", idleSeconds: 0, isSensitive: false },
      130 + MIN_DWELL_SECONDS + 1,
      defaultSettings,
    );
    // Blocked by cooldown
    expect(second).toBeNull();
  });
});

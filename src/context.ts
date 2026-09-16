/**
 * Context-driven companion engine (Clippy mode).
 * Monitors foreground application changes, evaluates rules, enforces anti-annoyance
 * dwell times and chattiness cooldowns, and triggers animations and interactive bubbles.
 */

import { listen } from "@tauri-apps/api/event";
import type { Bubble, BubbleChip } from "./bubble";
import type { Behavior } from "./behavior";
import type { Settings } from "./settings-store";

export interface ContextEventPayload {
  process: string;
  title: string;
  idleSeconds: number;
  isSensitive: boolean;
}

export interface ContextRuleMatch {
  process?: string[];
  title?: string[];
  timeRange?: { startHour: number; endHour: number };
}

export interface ContextRule {
  id: string;
  category: string;
  match: ContextRuleMatch;
  animation?: string;
  lines: string[];
  chips?: BubbleChip[];
}

export interface ContextRulesFile {
  rules: ContextRule[];
}

export interface ContextDecision {
  ruleId: string;
  category: string;
  line: string;
  animation?: string;
  chips?: BubbleChip[];
}

/** Chattiness to cooldown seconds mapping. */
export const CHATTINESS_COOLDOWNS: Record<string, number> = {
  chatty: 150, // 2.5 minutes
  normal: 360, // 6 minutes
  rare: 900, // 15 minutes
};

/** Minimum seconds the user must focus on an app before Buddy will react. */
export const MIN_DWELL_SECONDS = 18;

/** Maximum user idle seconds before considering the user AFK. */
export const MAX_IDLE_SECONDS = 15;

export function wildcardMatch(pattern: string, str: string): boolean {
  const p = pattern.toLowerCase();
  const s = str.toLowerCase();
  if (p === "*" || p === "*.*") return true;
  if (p.startsWith("*") && p.endsWith("*")) {
    return s.includes(p.slice(1, -1));
  }
  if (p.startsWith("*")) {
    return s.endsWith(p.slice(1));
  }
  if (p.endsWith("*")) {
    return s.startsWith(p.slice(0, -1));
  }
  return s === p;
}

export function matchesRule(rule: ContextRule, process: string, title: string, currentHour: number): boolean {
  const { match } = rule;

  // Check time range if specified
  if (match.timeRange) {
    const { startHour, endHour } = match.timeRange;
    let inRange = false;
    if (startHour <= endHour) {
      inRange = currentHour >= startHour && currentHour < endHour;
    } else {
      // Wraps around midnight (e.g. 23:00 to 05:00)
      inRange = currentHour >= startHour || currentHour < endHour;
    }
    if (!inRange) return false;
  }

  // If timeRange only (no process or title required), it matches
  if (!match.process?.length && !match.title?.length && match.timeRange) {
    return true;
  }

  // Check process matching
  let processMatched = false;
  if (match.process && match.process.length > 0) {
    const procLower = process.toLowerCase();
    processMatched = match.process.some((p) => {
      const target = p.toLowerCase();
      return procLower === target || procLower.endsWith(`\\${target}`) || procLower.endsWith(`/${target}`);
    });
    if (!processMatched) return false;
  }

  // Check title matching
  if (match.title && match.title.length > 0) {
    const titleMatched = match.title.some((t) => wildcardMatch(t, title));
    if (!titleMatched) return false;
  }

  return true;
}

export class ContextEngine {
  private rules: ContextRule[] = [];
  private lastTriggerTime = -Infinity;
  private currentProcess = "";
  private currentTitle = "";
  private dwellStartTime = 0;
  private lastTriggeredRuleId = "";
  private lastTriggeredProcess = "";

  constructor(rules: ContextRule[] = []) {
    this.rules = rules;
  }

  setRules(rules: ContextRule[]) {
    this.rules = rules;
  }

  /**
   * Evaluates incoming context event and returns a decision if conditions are met.
   */
  evaluate(
    event: ContextEventPayload,
    nowSeconds: number,
    settings: {
      enabled: boolean;
      chattiness: string;
      blacklist: string[];
    },
    currentHour: number = new Date().getHours(),
  ): ContextDecision | null {
    if (!settings.enabled) return null;

    // Ignore sensitive windows
    if (event.isSensitive) return null;

    // Blacklist check
    const procLower = event.process.toLowerCase();
    if (settings.blacklist.some((b) => procLower === b.toLowerCase())) {
      return null;
    }

    // Must not be AFK/idle
    if (event.idleSeconds > MAX_IDLE_SECONDS) {
      return null;
    }

    // Track dwell time
    if (event.process !== this.currentProcess || event.title !== this.currentTitle) {
      this.currentProcess = event.process;
      this.currentTitle = event.title;
      this.dwellStartTime = nowSeconds;
      return null;
    }

    const dwell = nowSeconds - this.dwellStartTime;
    if (dwell < MIN_DWELL_SECONDS) {
      return null;
    }

    // Don't re-trigger for the exact same process session
    if (this.lastTriggeredProcess === event.process && nowSeconds - this.lastTriggerTime < 600) {
      return null;
    }

    // Check cooldown
    const cooldown = CHATTINESS_COOLDOWNS[settings.chattiness] ?? CHATTINESS_COOLDOWNS.normal;
    if (nowSeconds - this.lastTriggerTime < cooldown) {
      return null;
    }

    // Find first matching rule
    for (const rule of this.rules) {
      if (rule.id === this.lastTriggeredRuleId && this.rules.length > 1) {
        continue; // Avoid immediate repeat of the same rule
      }

      if (matchesRule(rule, event.process, event.title, currentHour)) {
        if (!rule.lines.length) continue;
        const line = rule.lines[Math.floor(Math.random() * rule.lines.length)];

        this.lastTriggerTime = nowSeconds;
        this.lastTriggeredRuleId = rule.id;
        this.lastTriggeredProcess = event.process;

        return {
          ruleId: rule.id,
          category: rule.category,
          line,
          animation: rule.animation,
          chips: rule.chips,
        };
      }
    }

    return null;
  }

  resetCooldown() {
    this.lastTriggerTime = -Infinity;
  }
}

/**
 * High-level Context Coordinator: manages backend subscription,
 * ties together Bubble, Behavior animations, and Talk prompt handoff.
 */
export class ContextCoordinator {
  private engine = new ContextEngine();
  private unlisten: (() => void) | null = null;

  constructor(
    private getSettings: () => Settings,
    private onMuteApp: (processName: string) => void,
    private onOpenTalk: (prompt: string) => void,
  ) {}

  async init(bubble: Bubble, behavior: Behavior) {
    try {
      const res = await fetch("/contexts/rules.json");
      if (res.ok) {
        const data = (await res.json()) as ContextRulesFile;
        this.engine.setRules(data.rules || []);
      }
    } catch {
      // Keep engine empty or defaults if fetch fails
    }

    this.unlisten = await listen<ContextEventPayload>("context-event", (e) => {
      const s = this.getSettings();
      const now = performance.now() / 1000;

      const decision = this.engine.evaluate(
        e.payload,
        now,
        {
          enabled: s.contextReactionsEnabled,
          chattiness: s.contextChattiness,
          blacklist: s.contextBlacklist || [],
        },
      );

      if (decision) {
        // Trigger matching animation if available
        if (decision.animation) {
          behavior.queueFidget(decision.animation);
        }

        // Display speech bubble with action chips
        bubble.say(
          [decision.line],
          8.0, // generous duration for reading and clicking chips
          now,
          1, // priority 1 (over ordinary idle quips)
          decision.chips,
          (chip) => {
            this.handleChipClick(chip, e.payload.process, e.payload.title, bubble);
          },
        );
      }
    });
  }

  private handleChipClick(chip: BubbleChip, process: string, title: string, bubble: Bubble) {
    bubble.hide();

    if (chip.action === "mute") {
      this.onMuteApp(process);
      bubble.say([`Muted context reactions for ${process}.`], 3.5);
    } else if (chip.action === "ask") {
      const s = this.getSettings();
      let prompt = chip.prompt || "";
      if (s.contextLlmTitles && title && !title.startsWith("[")) {
        prompt += ` (Context: in ${process}, viewing '${title}')`;
      }
      this.onOpenTalk(prompt);
    }
  }

  destroy() {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
  }
}

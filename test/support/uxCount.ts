// UX-01 journey counter: every user input the journey needs goes through `u.*`, so the before/after
// tables count the same way. One click, one fill (a typed or pasted value), one check, one select and
// one file pick are one action each. A fill of a value this journey already typed counts as a repeat
// too. `setup()` wraps inputs that only the test harness needs (a non-default runner port) and are
// counted apart, never as the user's work.
import type { Locator, Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export type ActionKind = 'click' | 'fill' | 'check' | 'select' | 'file';

export interface JourneyCount {
  journey: string;
  actions: Record<ActionKind, number>;
  total: number;
  /** Values typed again in this journey (what the field was), e.g. a recipient confirmed by retyping. */
  repeats: string[];
  /** Harness-only inputs, not counted in `total`. */
  setup: number;
  /** Transactions the gas wallet confirmed (each costs one send + one confirm click above). */
  deploySteps: number;
  /** Times the user recovered from an error (each listed with the actions it took). */
  recoveries: Array<{ what: string; actions: number }>;
  pageLoads: number;
}

export class Journey {
  readonly c: JourneyCount;
  private typed = new Map<string, string>();
  private inSetup = false;
  private recovery: { what: string; start: number } | null = null;
  constructor(name: string) {
    this.c = { journey: name, actions: { click: 0, fill: 0, check: 0, select: 0, file: 0 }, total: 0, repeats: [], setup: 0, deploySteps: 0, recoveries: [], pageLoads: 0 };
  }
  private count(k: ActionKind) {
    if (this.inSetup) {
      this.c.setup++;
      return;
    }
    this.c.actions[k]++;
    this.c.total++;
  }
  click = async (l: Locator, o?: Parameters<Locator['click']>[0]) => (this.count('click'), l.click(o));
  check = async (l: Locator) => (this.count('check'), l.check());
  select = async (l: Locator, v: Parameters<Locator['selectOption']>[0]) => (this.count('select'), l.selectOption(v));
  file = async (l: Locator, f: Parameters<Locator['setInputFiles']>[0]) => (this.count('file'), l.setInputFiles(f));
  /** `field` names what is typed (recipient, amount…), so a second fill of the same value is a repeat. */
  fill = async (l: Locator, value: string, field: string) => {
    this.typedValue(value, field);
    return l.fill(value);
  };
  /**
   * A paste from the clipboard: one action, counted (and repeat-checked) like a fill. Dispatched as a real
   * `paste` ClipboardEvent on the focused field, so the page's own paste handler runs as it would for a user.
   */
  paste = async (l: Locator, value: string, field: string) => {
    this.typedValue(value, field);
    await l.focus();
    return l.evaluate((el, v) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', v);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, value);
  };
  private typedValue(value: string, field: string) {
    this.count('fill');
    if (this.inSetup) return;
    const before = [...this.typed.entries()].find(([, v]) => v === value && value.length > 3);
    if (before) this.c.repeats.push(`${field} (same value as ${before[0]})`);
    this.typed.set(field, value);
  }
  goto = async (p: Page, url: string) => (this.c.pageLoads++, p.goto(url));
  reload = async (p: Page) => (this.c.pageLoads++, p.reload());
  async setup<T>(fn: () => Promise<T>): Promise<T> {
    this.inSetup = true;
    try {
      return await fn();
    } finally {
      this.inSetup = false;
    }
  }
  startRecovery(what: string) {
    this.recovery = { what, start: this.c.total };
  }
  endRecovery() {
    if (this.recovery) this.c.recoveries.push({ what: this.recovery.what, actions: this.c.total - this.recovery.start });
    this.recovery = null;
  }
  /** Appends this journey to the JSON file `UX_JOURNEY_OUT` names (default test-results/ux-journeys.json). */
  save() {
    const out = process.env.UX_JOURNEY_OUT ?? 'test-results/ux-journeys.json';
    mkdirSync(dirname(out), { recursive: true });
    const list: JourneyCount[] = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as JourneyCount[]).filter((j) => j.journey !== this.c.journey) : [];
    list.push(this.c);
    writeFileSync(out, JSON.stringify(list, null, 2) + '\n');
  }
}

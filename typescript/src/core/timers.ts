/**
 * TimerBag (design §4.6): the state's `after` timer plus fx.delay
 * handles. Standard setTimeout only — identical in browser, Node and
 * workers; tests drive it with fake timers on the globals.
 */

import type { DelayHandle } from "./types.js";

interface DelayEntry {
  handle: ReturnType<typeof setTimeout>;
  sticky: boolean;
}

export class TimerBag {
  private afterHandle: ReturnType<typeof setTimeout> | undefined;
  private readonly delays = new Set<DelayEntry>();

  /** Arm the state's `after` timer (spec §3.2): one per state entry. */
  armAfter(delayMs: number, fire: () => void): void {
    this.clearAfter();
    this.afterHandle = setTimeout(fire, delayMs);
  }

  /** fx.delay (spec §4.3): cancelled on state exit unless sticky. */
  delay(ms: number, sticky: boolean, fire: () => void): DelayHandle {
    const entry: DelayEntry = { handle: undefined as never, sticky };
    entry.handle = setTimeout(() => {
      this.delays.delete(entry);
      fire();
    }, ms);
    this.delays.add(entry);
    return {
      cancel: () => {
        clearTimeout(entry.handle);
        this.delays.delete(entry);
      },
    };
  }

  /** State exit: cancel the after timer and all non-sticky delays. */
  onExit(): void {
    this.clearAfter();
    for (const entry of [...this.delays]) {
      if (!entry.sticky) {
        clearTimeout(entry.handle);
        this.delays.delete(entry);
      }
    }
  }

  /** Terminal transition: everything goes, sticky included (spec §8.3). */
  cancelAll(): void {
    this.clearAfter();
    for (const entry of this.delays) clearTimeout(entry.handle);
    this.delays.clear();
  }

  private clearAfter(): void {
    if (this.afterHandle !== undefined) {
      clearTimeout(this.afterHandle);
      this.afterHandle = undefined;
    }
  }
}

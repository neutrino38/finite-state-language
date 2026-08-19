/**
 * TimerBag (design §4.6): the state's `after` timer plus fx.delay
 * handles. Standard setTimeout only — identical in browser, Node and
 * workers; tests drive it with fake timers on the globals.
 *
 * Delays are scoped (design §12.4). Entering a Service Building Block
 * opens a scope; leaving it cancels the delays armed inside and leaves
 * the host's own delays alone — the host never left its state, so
 * "cancelled on state exit" must not fire for it.
 */

import type { DelayHandle } from "./types.js";

interface DelayEntry {
  handle: ReturnType<typeof setTimeout>;
  sticky: boolean;
  scope: number;
}

export class TimerBag {
  private afterHandle: ReturnType<typeof setTimeout> | undefined;
  private readonly delays = new Set<DelayEntry>();
  /** Depth of the SBB stack the timers belong to (0 = the host). */
  private scope = 0;

  /** Arm the state's `after` timer (spec §3.2): one per state entry. */
  armAfter(delayMs: number, fire: () => void): void {
    this.clearAfter();
    this.afterHandle = setTimeout(fire, delayMs);
  }

  /**
   * Cancel the `after` timer alone. Entering a block suspends the
   * host's deadline (spec §8.4) without touching anything else.
   */
  cancelAfter(): void {
    this.clearAfter();
  }

  /** fx.delay (spec §4.3): cancelled on state exit unless sticky. */
  delay(ms: number, sticky: boolean, fire: () => void): DelayHandle {
    const entry: DelayEntry = {
      handle: undefined as never,
      sticky,
      scope: this.scope,
    };
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

  /**
   * State exit: cancel the after timer and the non-sticky delays armed
   * in the current scope (§3.2). A delay the host armed before calling
   * a block is in an outer scope and survives the block's state hops.
   */
  onExit(): void {
    this.clearAfter();
    this.dropScope(this.scope);
  }

  /** Entering an SBB: delays armed from here belong to the block. */
  pushScope(): void {
    this.scope++;
  }

  /**
   * Leaving an SBB: its after timer and its non-sticky delays go, the
   * host's stay. Sticky delays outlive the block, as they outlive a
   * state — that is what sticky means.
   */
  popScope(): void {
    this.clearAfter();
    this.dropScope(this.scope);
    if (this.scope > 0) this.scope--;
  }

  /** Terminal transition: everything goes, sticky included (spec §8.3). */
  cancelAll(): void {
    this.clearAfter();
    for (const entry of this.delays) clearTimeout(entry.handle);
    this.delays.clear();
    this.scope = 0;
  }

  private dropScope(scope: number): void {
    for (const entry of [...this.delays]) {
      if (!entry.sticky && entry.scope === scope) {
        clearTimeout(entry.handle);
        this.delays.delete(entry);
      }
    }
  }

  private clearAfter(): void {
    if (this.afterHandle !== undefined) {
      clearTimeout(this.afterHandle);
      this.afterHandle = undefined;
    }
  }
}

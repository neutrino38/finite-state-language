/**
 * The pending queue: selective receive for unmatched events
 * (spec §4.2, design §4.5). Bounded FIFO; overflow drops the oldest.
 */

import type { AnyEvent } from "./types.js";

export class PendingQueue<Ev extends AnyEvent> {
  private arr: Ev[] = [];

  constructor(
    private readonly max: number,
    private readonly onDrop: (ev: Ev) => void,
  ) {}

  get length(): number {
    return this.arr.length;
  }

  at(i: number): Ev {
    // callers only index within [0, length)
    return this.arr[i] as Ev;
  }

  removeAt(i: number): void {
    this.arr.splice(i, 1);
  }

  push(ev: Ev): void {
    if (this.arr.length >= this.max) {
      const dropped = this.arr.shift();
      if (dropped) this.onDrop(dropped);
    }
    this.arr.push(ev);
  }

  clear(): void {
    this.arr.length = 0;
  }

  list(): readonly Ev[] {
    return Object.freeze([...this.arr]);
  }

  drop(sel: string | ((ev: Ev) => boolean)): void {
    const pred = typeof sel === "string" ? (ev: Ev) => ev.type === sel : sel;
    this.arr = this.arr.filter((ev) => !pred(ev));
  }
}

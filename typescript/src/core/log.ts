/**
 * Transition ring buffer (spec §6, design §9): the last N transitions,
 * exposed as `instance.log`.
 */

export interface LogEntry {
  readonly seq: number;
  readonly from: string;
  readonly to: string;
  readonly event?: string;
  readonly desc?: string;
}

export class TransitionLog {
  private buf: LogEntry[] = [];
  private seq = 0;

  constructor(private readonly size: number) {}

  push(entry: Omit<LogEntry, "seq">): void {
    this.buf.push({ seq: this.seq++, ...entry });
    if (this.buf.length > this.size) this.buf.shift();
  }

  list(): readonly LogEntry[] {
    return Object.freeze([...this.buf]);
  }
}

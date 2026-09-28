/**
 * The trace of one run, and its sequence diagram (spec §6.2, design §9.3).
 *
 * `instance.log` is a ring buffer of the last N transitions: enough to
 * say where a machine has been lately, not enough to draw what it did.
 * A trace is the whole run from the moment it was started — every
 * transition, how the machine ended, and, when a binding records them,
 * the messages that actually went over the wire. The counterpart of
 * FSL Elixir's `FSL.Journal`, rendered as the same Mermaid sequence
 * diagram `FSL.Diagram.Mermaid` draws.
 *
 * Off by default, and free when off: an instance started without
 * `trace` keeps no list and `record()` returns at once.
 */

import type { Outcome } from "./types.js";

/** Milliseconds on a monotonic clock — `performance.now()`. */
export function now(): number {
  return globalThis.performance.now();
}

/** A state change, as `instance.log` records it, stamped. */
export interface TraceTransition {
  readonly kind: "transition";
  /** `performance.now()` when it happened, in milliseconds. */
  readonly at: number;
  readonly from: string;
  readonly to: string;
  /** The event type that caused it; absent for a transition nothing caused. */
  readonly event?: string;
  readonly desc?: string;
  /**
   * True when the machine caused it itself — its start, an `after`, a
   * shutdown, a block entered or returned from, a message from a parent
   * or a child. Such a transition came from nowhere and is drawn as a
   * note, never as an arrow from the peer.
   */
  readonly internal: boolean;
}

/** How the run ended. */
export interface TraceTerminal {
  readonly kind: "terminal";
  readonly at: number;
  readonly outcome: Outcome;
  readonly reason?: string;
}

/**
 * What actually went over the wire, recorded by the binding with
 * `instance.record()`. The binding decides what every field says; the
 * renderer knows nothing of the protocol.
 */
export interface TraceMessage {
  readonly kind: "message";
  readonly at: number;
  readonly dir: "in" | "out";
  /** The conversation it belongs to (SIP: the Call-ID). One lane each. */
  readonly lane: string;
  /** Local label of that conversation (SIP: the leg tag). */
  readonly party?: string;
  /** The far end (SIP: "10.0.0.1:5060/udp"). */
  readonly peer?: string;
  /** Drawn as is. */
  readonly label: string;
  /** A reply: dotted. */
  readonly reply?: boolean;
  /** A repetition (a retransmission): open arrowhead. */
  readonly repeat?: boolean;
}

export type TraceEvent = TraceTransition | TraceTerminal | TraceMessage;

/** What `instance.record()` takes: a message, `at` stamped when absent. */
export type TraceMessageInput = Omit<TraceMessage, "at"> & {
  readonly at?: number;
};

/** A run, as `instance.trace` hands it out. */
export interface Trace {
  /** The machine's `name`. */
  readonly machine: string;
  /** `performance.now()` when the trace started: the diagram's origin. */
  readonly t0: number;
  /** Oldest first, ordered by `at`. */
  readonly events: readonly TraceEvent[];
}

/** Internal: the recorder an instance holds once its trace has started. */
export class TraceRecorder {
  private readonly buf: TraceEvent[] = [];
  readonly t0 = now();

  constructor(
    private readonly machine: string,
    private readonly size: number,
  ) {}

  push(event: TraceEvent): void {
    this.buf.push(event);
    if (this.buf.length > this.size) this.buf.shift();
  }

  view(): Trace {
    // A binding may hand over a message stamped earlier than what the
    // machine recorded since — it saw it on its own clock. `at` decides
    // the order, and the sort is stable for events recorded at the same
    // millisecond.
    const events = [...this.buf].sort((a, b) => a.at - b.at);
    return Object.freeze({
      machine: this.machine,
      t0: this.t0,
      events: Object.freeze(events),
    });
  }
}

export interface SequenceOpts {
  /** The local lane's label; defaults to the machine's name. */
  label?: string;
  /** The peer lane's label, in a run with no messages. Bare when absent. */
  peer?: string;
  /**
   * Where an event that caused a transition came from. The default is
   * **by exclusion**: anything the machine did not cause itself came from
   * the peer. A binding whose machine also hears a user interface says so
   * — `(type) => (type.startsWith("ui:") ? "local" : "peer")` — rather
   * than the renderer guessing a protocol from a prefix.
   */
  lane?: (eventType: string) => "peer" | "local";
}

/**
 * Render a trace as a Mermaid `sequenceDiagram`: the same lanes, arrows
 * and notes as FSL Elixir's `FSL.Diagram.Mermaid`, so the two ends of one
 * call can be read side by side.
 *
 * Every label carries `+Nms`, the time since the trace started. One
 * `message` in the trace switches to **traced mode**: one peer lane per
 * conversation instead of the single peer lane, and a transition no
 * longer draws an arrow of its own — the arrows are the real messages
 * now. An event of a kind the renderer does not know is skipped.
 */
export function traceToMermaid(trace: Trace, opts: SequenceOpts = {}): string {
  const lanes = messageLanes(trace.events);
  const aliases = new Map(lanes.map((l) => [l.lane, l.alias]));
  const traced = lanes.length > 0;
  const laneOf = opts.lane ?? (() => "peer" as const);
  const stamp = (e: TraceEvent): string => `+${Math.round(e.at - trace.t0)}ms `;
  const label = (e: TraceEvent, text: string): string =>
    escape(stamp(e) + text);

  const header = [`%% Machine : ${trace.machine}`];
  if (traced) {
    header.push("%% Peers (one per conversation):");
    for (const l of lanes)
      header.push(`%%   ${l.alias}: ${l.label} — ${l.lane}`);
  }

  const participants = [participant(LOCAL, opts.label ?? trace.machine)];
  if (traced) {
    for (const l of lanes) participants.push(participant(l.alias, l.label));
  } else {
    participants.push(participant(PEER, opts.peer));
  }

  const body: string[] = [];
  for (const e of trace.events as readonly { kind: string }[]) {
    const ev = e as TraceEvent;
    switch (e.kind) {
      case "message": {
        const m = ev as TraceMessage;
        const lane = aliases.get(m.lane) ?? PEER;
        const [from, to] = m.dir === "in" ? [lane, LOCAL] : [LOCAL, lane];
        body.push(`    ${from}${arrow(m)}${to}: ${label(m, m.label)}`);
        break;
      }
      case "transition": {
        const t = ev as TraceTransition;
        if (
          !traced &&
          !t.internal &&
          t.event !== undefined &&
          laneOf(t.event) === "peer"
        ) {
          body.push(`    ${PEER}->>${LOCAL}: ${label(t, t.event)}`);
        }
        const move = t.from === START ? t.to : `${t.from} -> ${t.to}`;
        const text = t.desc ? `${move}: ${t.desc}` : move;
        body.push(`    Note over ${LOCAL}: ${label(t, text)}`);
        break;
      }
      case "terminal": {
        const t = ev as TraceTerminal;
        const text = t.reason ? `${t.outcome}: ${t.reason}` : t.outcome;
        body.push(`    Note over ${LOCAL}: ${label(t, text)}`);
        break;
      }
      default:
        // A kind this renderer does not know is skipped rather than
        // failing the whole diagram.
        break;
    }
  }

  return [...header, "sequenceDiagram", ...participants, ...body].join("\n");
}

// ---- internals --------------------------------------------------------------

const LOCAL = "local";
const PEER = "peer";
/** The name `instance.log` gives the state before `initial_state`. */
const START = "(start)";

function participant(id: string, label: string | undefined): string {
  return label === undefined
    ? `    participant ${id}`
    : `    participant ${id} as ${escape(label)}`;
}

/** Solid for a request, dotted for a reply, open arrowhead for a repetition. */
function arrow(m: TraceMessage): string {
  const reply = m.reply === true;
  if (m.repeat === true) return reply ? "--)" : "-)";
  return reply ? "-->>" : "->>";
}

interface Lane {
  lane: string;
  alias: string;
  label: string;
}

/**
 * One lane per distinct `lane` of the messages, in order of first
 * appearance. Labelled with the first `party` and the first `peer` seen
 * on it, joined by a space, or `peer N` when neither is known.
 */
function messageLanes(events: readonly TraceEvent[]): Lane[] {
  const seen = new Map<string, { party?: string; peer?: string }>();
  for (const e of events) {
    if (e.kind !== "message") continue;
    const known = seen.get(e.lane) ?? {};
    seen.set(e.lane, {
      party: known.party ?? e.party,
      peer: known.peer ?? e.peer,
    });
  }
  return [...seen].map(([lane, { party, peer }], i) => {
    const joined = [party, peer].filter((s) => s !== undefined).join(" ");
    return {
      lane,
      alias: `peer${i + 1}`,
      label: joined === "" ? `peer ${i + 1}` : joined,
    };
  });
}

/**
 * `#` opens an entity code and `;` ends a statement, so both become
 * entities — in one pass, because each entity contains the other
 * character. A newline ends a line. An empty label makes Mermaid drop
 * the arrow without a word, so it never stays empty.
 */
function escape(text: string): string {
  const out = text
    .replace(/[#;]/g, (c) => (c === "#" ? "#35;" : "#59;"))
    .replace(/[\r\n]+/g, " ")
    .trim();
  return out === "" ? "?" : out;
}

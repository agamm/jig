// Turns raw server log lines into readable rows and groups each jig run into
// a block. Pure functions; the Logs page renders the result.
import type { ServerLogEntry } from "../../../shared/api";

export type LogKind = "run" | "step" | "llm" | "agent" | "tool" | "conn" | "sched" | "repair" | "webhook" | "sys";

export interface LogItem {
  entry: ServerLogEntry;
  kind: LogKind;
  title: string;
  detail?: string;
  jigId?: string;
  runId?: number;
  dryRun?: boolean;
  durationMs?: number;
  error?: string;
  failed: boolean;
  /** Lifecycle noise (runner start/done, LLM request once answered). Hidden unless verbose. */
  plumbing: boolean;
  role?: "run-start" | "run-end" | "step-start" | "step-end" | "llm-request" | "llm-response" | "tool-call" | "tool-result";
  seq?: number;
  tool?: string;
}

export interface RunBlock {
  key: string;
  jigId: string;
  runId?: number;
  dryRun: boolean;
  status: "running" | "ok" | "failed" | "unknown";
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
  items: LogItem[];
  counts: { steps: number; failedSteps: number; llm: number; tools: number };
}

export type LogGroup = { type: "run"; run: RunBlock } | { type: "entry"; item: LogItem };

// ---------------------------------------------------------------------------
// Which raw lines count as operational (mirrors isInterestingForDebug in the CLI)
// ---------------------------------------------------------------------------

export function isOperationalLog(entry: ServerLogEntry): boolean {
  const msg = entry.msg.trim();
  if (entry.level === "error") return true;
  if (/^\[run(\.step)?\]\s/.test(msg)) return true;
  if (/^\[runner\]\s/.test(msg)) return true;
  if (/^\[sdk\.(llm|agent)\]\s/.test(msg)) return true;
  if (/^\[mcp\.(tool|connection)\]\s/.test(msg)) return true;
  if (/^\[authoring\.(agent|discovery)\]\s/.test(msg)) return true;
  if (/^\[repair\]\s/.test(msg)) return true;
  if (/^\[session-log\]\s/.test(msg)) return true;
  if (/^\[scheduler\]\s/.test(msg) && /(started|done|failed|error|catch-up|marked|skipped|triggered)/i.test(msg)) return true;
  if (/^\[connection\]\s/.test(msg)) return true;
  if (/^\[composio\]\s/.test(msg) && /(connected|discovered|failed|error)/i.test(msg)) return true;
  if (/^\[webhook\]\s/.test(msg)) return true;
  if (/^API error:/i.test(msg)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Parsing `[source] event key=value key=value ...`
// ---------------------------------------------------------------------------

export interface Headline {
  source: string;
  event: string;
  rest: string;
  fields: Record<string, string>;
}

const HEADLINE = /^\[([\w.:-]+)\]\s+(\S+)(?:\s+([\s\S]*))?$/;

export function parseHeadline(msg: string): Headline | null {
  const m = HEADLINE.exec(msg.trim());
  if (!m) return null;
  const rest = m[3] ?? "";
  return { source: m[1], event: m[2], rest, fields: parseFields(rest) };
}

// Keys the server puts in a headline (HEADLINE_KEYS in src/debug/session-log.ts).
// Splitting only at these keeps "x=y" fragments inside error text or step labels intact.
const HEADLINE_FIELD = /(?:^|\s)(jig|jigId|jigName|runId|seq|step|sessionId|model|round|tool|mode|runType|finishReason|status|durationMs|error)=/g;

// Values may contain spaces (step labels, error text); a value ends where the
// next known ` key=` begins.
export function parseFields(tail: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = new RegExp(HEADLINE_FIELD.source, "g");
  const hits: { key: string; keyStart: number; valueStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail))) hits.push({ key: m[1], keyStart: m.index, valueStart: m.index + m[0].length });
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].keyStart : tail.length;
    fields[h.key] = tail.slice(h.valueStart, end).trim();
  });
  return fields;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------------------
// Describe one entry
// ---------------------------------------------------------------------------

const RUN_STARTED = /^\[(?:run|scheduler)\]\s+(\S+)\s+started\s+\(runId=(-?\d+)(,\s*dry-?[Rr]un)?\)/;
const RUN_DONE = /^\[(?:run|scheduler)\]\s+(\S+)\s+done in (\d+)ms/;
const RUN_ERROR = /^\[(?:run|scheduler)\]\s+(\S+)\s+error:\s*([\s\S]*)$/;

export function describeLog(entry: ServerLogEntry): LogItem {
  const msg = entry.msg.trim();
  const base: LogItem = { entry, kind: "sys", title: msg, failed: entry.level === "error", plumbing: false };

  let m = RUN_STARTED.exec(msg);
  if (m) {
    const dryRun = Boolean(m[3]);
    return { ...base, kind: "run", role: "run-start", jigId: m[1], runId: Number(m[2]), dryRun, title: dryRun ? "Dry run started" : "Run started" };
  }
  m = RUN_DONE.exec(msg);
  if (m) {
    const durationMs = Number(m[2]);
    return { ...base, kind: "run", role: "run-end", jigId: m[1], durationMs, title: "Run finished", detail: fmtDuration(durationMs), failed: false };
  }
  m = RUN_ERROR.exec(msg);
  if (m) {
    return { ...base, kind: "run", role: "run-end", jigId: m[1], error: m[2], title: "Run failed", detail: m[2], failed: true };
  }

  const h = parseHeadline(msg);
  if (!h) {
    if (/^API error:/i.test(msg)) return { ...base, kind: "sys", failed: true };
    return base;
  }
  const f = h.fields;
  const ctx = {
    jigId: f.jigId || f.jig || undefined,
    runId: num(f.runId),
    dryRun: f.runType ? f.runType === "dry-run" : undefined,
    durationMs: num(f.durationMs),
    error: f.error || undefined,
  };
  const failed = entry.level === "error" || Boolean(f.error);
  const withCtx = (patch: Partial<LogItem>): LogItem => ({ ...base, ...ctx, failed, ...patch });

  switch (h.source) {
    // The runner's own lifecycle lines sit next to the API's "[run] ..." lines for the same
    // run, so they are titled "Runner ..." to read as a second source, not a duplicate.
    case "runner": {
      switch (h.event) {
        case "start":
          return withCtx({ kind: "run", role: "run-start", title: ctx.dryRun ? "Runner started (dry run)" : "Runner started", plumbing: true });
        case "executing-handler":
          return withCtx({ kind: "run", title: "Handler loaded", detail: f.model && f.model !== "null" ? `model ${f.model}` : undefined, plumbing: true });
        case "done":
          return withCtx({ kind: "run", role: "run-end", title: "Runner finished", detail: fmtDuration(ctx.durationMs), plumbing: true, failed: false });
        case "error":
          return withCtx({ kind: "run", role: "run-end", title: "Runner failed", detail: ctx.error, failed: true });
        case "llm-error":
          return withCtx({ kind: "run", title: "Model call failed", detail: ctx.error, failed: true });
        case "skipped":
          return withCtx({ kind: "run", role: "run-end", title: "Run skipped", detail: f.reason, failed: false });
        default:
          return withCtx({ kind: "run", title: `Runner ${h.event}`, plumbing: true });
      }
    }
    case "run.step": {
      const seq = num(f.seq);
      const label = f.step ?? "";
      const stepName = seq !== undefined ? `Step ${seq}` : "Step";
      if (h.event === "start") return withCtx({ kind: "step", role: "step-start", seq, title: `${stepName} started`, detail: label });
      if (h.event === "failed") return withCtx({ kind: "step", role: "step-end", seq, title: `${stepName} failed`, detail: [label, ctx.error].filter(Boolean).join(" · "), failed: true });
      return withCtx({ kind: "step", role: "step-end", seq, title: `${stepName} done`, detail: [label, fmtDuration(ctx.durationMs)].filter(Boolean).join(" · "), failed: false });
    }
    case "sdk.llm": {
      const mode = f.mode ? ` · ${f.mode}` : "";
      if (h.event === "request") return withCtx({ kind: "llm", role: "llm-request", title: "LLM request", detail: `${f.model ?? "?"}${mode}` });
      const finish = f.finishReason && f.finishReason !== "stop" ? ` · ${f.finishReason}` : "";
      return withCtx({ kind: "llm", role: "llm-response", title: "LLM response", detail: `${f.model ?? "?"}${mode}${finish}` });
    }
    case "sdk.agent": {
      const round = f.round ? `round ${f.round}` : "";
      switch (h.event) {
        case "start": return withCtx({ kind: "agent", title: "Agent started", detail: f.model });
        case "round-request": return withCtx({ kind: "agent", title: `Agent ${round} request`, plumbing: true });
        case "round-response": return withCtx({ kind: "agent", title: `Agent ${round}`, detail: f.finishReason && f.finishReason !== "stop" ? f.finishReason : undefined });
        case "tool-result": return withCtx({ kind: "agent", title: `Agent tool ${f.tool ?? "?"}`, detail: round });
        case "tool-error": return withCtx({ kind: "agent", title: `Agent tool ${f.tool ?? "?"} failed`, detail: ctx.error, failed: true });
        case "done": return withCtx({ kind: "agent", title: "Agent done", detail: f.round ? `${f.round} rounds` : undefined });
        default: return withCtx({ kind: "agent", title: `Agent ${h.event}`, detail: round || undefined });
      }
    }
    case "mcp.tool": {
      const tool = f.tool ?? "?";
      if (h.event === "call") return withCtx({ kind: "tool", role: "tool-call", tool, title: `Tool ${tool}`, detail: "called" });
      if (h.event === "error") return withCtx({ kind: "tool", role: "tool-result", tool, title: `Tool ${tool} failed`, detail: [fmtDuration(ctx.durationMs), ctx.error].filter(Boolean).join(" · "), failed: true });
      return withCtx({ kind: "tool", role: "tool-result", tool, title: `Tool ${tool}`, detail: fmtDuration(ctx.durationMs), failed: false });
    }
    case "mcp.connection":
    case "connection":
    case "composio":
      return withCtx({ kind: "conn", title: `${h.event}${h.rest ? " " + h.rest : ""}` });
    case "scheduler":
      return withCtx({ kind: "sched", title: `${h.event}${h.rest ? " " + h.rest : ""}` });
    case "repair":
      return withCtx({ kind: "repair", title: `${h.event}${h.rest ? " " + h.rest : ""}` });
    case "webhook":
      return withCtx({ kind: "webhook", title: `${h.event}${h.rest ? " " + h.rest : ""}` });
    case "authoring.agent":
    case "authoring.discovery":
      return withCtx({ kind: "agent", title: `${h.source.split(".")[1]} ${h.event}`, detail: h.rest || undefined });
    default:
      return withCtx({ kind: "sys", title: msg });
  }
}

// ---------------------------------------------------------------------------
// Group entries into run blocks
// ---------------------------------------------------------------------------

const RUN_SCOPED: ReadonlySet<LogKind> = new Set(["step", "llm", "agent", "tool"]);
const CLOSE_GRACE_MS = 5_000;
const STALE_RUN_MS = 45 * 60_000;

export function groupRuns(items: LogItem[], now: number = Date.now()): LogGroup[] {
  const groups: LogGroup[] = [];
  const byRunId = new Map<number, RunBlock>();
  const openByJig = new Map<string, RunBlock>();
  const lastByJig = new Map<string, RunBlock>();
  const open = new Set<RunBlock>();
  const pendingByBlock = new Map<RunBlock, { steps: Map<number, LogItem>; llm: LogItem[]; tools: Map<string, LogItem[]> }>();

  const pending = (b: RunBlock) => {
    let p = pendingByBlock.get(b);
    if (!p) { p = { steps: new Map(), llm: [], tools: new Map() }; pendingByBlock.set(b, p); }
    return p;
  };

  const openBlock = (item: LogItem, jigId: string): RunBlock => {
    const stale = openByJig.get(jigId);
    if (stale) close(stale, { status: "unknown", at: item.entry.ts });
    const block: RunBlock = {
      key: `${jigId}:${item.runId ?? "local"}:${item.entry.seq}`,
      jigId,
      runId: item.runId,
      dryRun: item.dryRun ?? false,
      status: "running",
      startedAt: item.entry.ts,
      items: [],
      counts: { steps: 0, failedSteps: 0, llm: 0, tools: 0 },
    };
    groups.push({ type: "run", run: block });
    if (item.runId !== undefined) byRunId.set(item.runId, block);
    openByJig.set(jigId, block);
    lastByJig.set(jigId, block);
    open.add(block);
    return block;
  };

  const close = (b: RunBlock, opts: { status: RunBlock["status"]; at: number; durationMs?: number; error?: string }) => {
    if (open.has(b)) {
      b.status = opts.status;
      b.endedAt = opts.at;
      b.durationMs = opts.durationMs ?? Math.max(0, opts.at - b.startedAt);
      if (opts.error) b.error = opts.error;
      open.delete(b);
      if (openByJig.get(b.jigId) === b) openByJig.delete(b.jigId);
    } else if (opts.status === "failed" && b.status !== "failed") {
      b.status = "failed";
      if (opts.error) b.error = opts.error;
    }
  };

  const attach = (b: RunBlock, item: LogItem) => {
    // The header carries status, duration and error. A run-end row stays visible only for the
    // first failure that no step already explained (import errors, timeouts, handler throws).
    if (item.role === "run-start") item.plumbing = true;
    if (item.role === "run-end") item.plumbing = !item.failed || !open.has(b) || b.counts.failedSteps > 0;
    const p = pending(b);
    if (item.role === "step-start" && item.seq !== undefined) p.steps.set(item.seq, item);
    if (item.role === "step-end") {
      b.counts.steps += 1;
      if (item.failed) b.counts.failedSteps += 1;
      const start = item.seq !== undefined ? p.steps.get(item.seq) : undefined;
      if (start) { start.plumbing = true; p.steps.delete(item.seq as number); }
    }
    if (item.role === "llm-request") { b.counts.llm += 1; p.llm.push(item); }
    if (item.role === "llm-response") { const req = p.llm.shift(); if (req) req.plumbing = true; }
    if (item.role === "tool-call" && item.tool) {
      b.counts.tools += 1;
      const q = p.tools.get(item.tool) ?? [];
      q.push(item);
      p.tools.set(item.tool, q);
    }
    if (item.role === "tool-result" && item.tool) { const call = p.tools.get(item.tool)?.shift(); if (call) call.plumbing = true; }
    b.items.push(item);
  };

  for (const item of items) {
    const ts = item.entry.ts;
    let block: RunBlock | undefined;
    if (item.runId !== undefined) block = byRunId.get(item.runId);
    if (!block && item.jigId) {
      block = openByJig.get(item.jigId);
      if (!block) {
        const last = lastByJig.get(item.jigId);
        if (last && last.endedAt !== undefined && ts - last.endedAt <= CLOSE_GRACE_MS) block = last;
      }
    }
    if (!block && !item.jigId && RUN_SCOPED.has(item.kind) && open.size === 1) block = [...open][0];

    if (item.role === "run-start") {
      const jigId = item.jigId ?? block?.jigId;
      if (jigId && (!block || !open.has(block) || (item.runId !== undefined && block.runId !== item.runId))) block = openBlock(item, jigId);
      if (block) { attach(block, item); continue; }
    }

    if (!block) {
      groups.push({ type: "entry", item });
      continue;
    }

    attach(block, item);
    if (item.role === "run-end") {
      const status: RunBlock["status"] = item.failed ? "failed" : "ok";
      close(block, { status, at: ts, durationMs: item.durationMs, error: item.error });
    }
  }

  for (const b of open) {
    const last = b.items[b.items.length - 1]?.entry.ts ?? b.startedAt;
    if (now - last > STALE_RUN_MS) b.status = "unknown";
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Filtering (level, text, verbose)
// ---------------------------------------------------------------------------

export interface LogFilter {
  level: "all" | "warn" | "error";
  query: string;
  verbose: boolean;
}

export function itemMatches(item: LogItem, filter: LogFilter): boolean {
  if (!filter.verbose && item.plumbing) return false;
  const level = item.entry.level;
  if (filter.level === "warn" && level === "info" && !item.failed) return false;
  if (filter.level === "error" && level !== "error" && !item.failed) return false;
  const q = filter.query.trim().toLowerCase();
  if (q) {
    const hay = `${item.title} ${item.detail ?? ""} ${item.entry.msg}`.toLowerCase();
    if (!hay.includes(q)) {
      const payload = item.entry.payload;
      if (typeof payload !== "string" || !payload.toLowerCase().includes(q)) return false;
    }
  }
  return true;
}

export function filterGroups(groups: LogGroup[], filter: LogFilter): LogGroup[] {
  const q = filter.query.trim().toLowerCase();
  const out: LogGroup[] = [];
  for (const g of groups) {
    if (g.type === "entry") {
      if (itemMatches(g.item, filter)) out.push(g);
      continue;
    }
    const items = g.run.items.filter((i) => itemMatches(i, filter));
    const headerText = `${g.run.jigId} run ${g.run.runId ?? ""} ${g.run.error ?? ""}`.toLowerCase();
    const headerMatches = (!q || headerText.includes(q)) && (filter.level === "all" || g.run.status === "failed");
    if (items.length > 0 || headerMatches) out.push({ type: "run", run: { ...g.run, items } });
  }
  return out;
}

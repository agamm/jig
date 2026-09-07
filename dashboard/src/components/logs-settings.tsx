"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/button";
import { LoadingState, Notice } from "@/components/state-panel";
import { clearServerLogs, fetchServerLogs, type ServerLogEntry } from "@/lib/api";
import {
  describeLog,
  filterGroups,
  fmtDuration,
  groupRuns,
  isOperationalLog,
  type LogFilter,
  type LogGroup,
  type LogItem,
  type LogKind,
  type RunBlock,
} from "@/lib/log-view";

const POLL_MS = 2000;

const KIND_STYLE: Record<LogKind, { label: string; cls: string }> = {
  run: { label: "run", cls: "text-emerald-400/80" },
  step: { label: "step", cls: "text-sky-300/80" },
  llm: { label: "llm", cls: "text-violet-300/80" },
  agent: { label: "agent", cls: "text-fuchsia-300/70" },
  tool: { label: "tool", cls: "text-amber-200/70" },
  conn: { label: "conn", cls: "text-teal-300/70" },
  sched: { label: "sched", cls: "text-[#8d8d95]" },
  webhook: { label: "hook", cls: "text-cyan-300/70" },
  sys: { label: "sys", cls: "text-[#777]" },
};

const STATUS_DOT: Record<RunBlock["status"], string> = {
  running: "bg-amber-300 animate-pulse",
  ok: "bg-emerald-400",
  failed: "bg-rose-400",
  unknown: "bg-[#555]",
};

function formatPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function fmtClock(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

function runStatusText(run: RunBlock): string {
  const dur = fmtDuration(run.durationMs);
  switch (run.status) {
    case "running":
      return "running";
    case "ok":
      return dur ? `ok in ${dur}` : "ok";
    case "failed":
      return dur ? `failed after ${dur}` : "failed";
    case "unknown":
      return "unfinished";
  }
}

function runCounts(run: RunBlock): string {
  const parts: string[] = [];
  if (run.counts.steps) parts.push(`${run.counts.steps} step${run.counts.steps === 1 ? "" : "s"}${run.counts.failedSteps ? ` (${run.counts.failedSteps} failed)` : ""}`);
  if (run.counts.llm) parts.push(`${run.counts.llm} llm`);
  if (run.counts.tools) parts.push(`${run.counts.tools} tool${run.counts.tools === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function exportText(groups: LogGroup[]): string {
  const lines: string[] = [];
  for (const g of groups) {
    if (g.type === "entry") {
      lines.push(`${new Date(g.item.entry.ts).toISOString()} [${g.item.entry.level}] ${g.item.entry.msg}`);
      continue;
    }
    const r = g.run;
    lines.push(`=== ${r.jigId} ${r.dryRun ? "dry run" : r.runId !== undefined ? `run #${r.runId}` : "run"} · ${runStatusText(r)}${r.error ? ` · ${r.error}` : ""} ===`);
    for (const i of r.items) lines.push(`${new Date(i.entry.ts).toISOString()} [${i.entry.level}] ${i.entry.msg}`);
  }
  return lines.join("\n");
}

function LogRow({ item, indent, open, onToggle }: { item: LogItem; indent: boolean; open: boolean; onToggle: () => void }) {
  const { entry } = item;
  const hasPayload = typeof entry.payload === "string" && entry.payload.length > 0;
  const expandable = hasPayload || entry.msg.trim() !== item.title;
  const kind = KIND_STYLE[item.kind];
  const titleCls = item.failed ? "text-rose-300" : entry.level === "warn" ? "text-amber-200" : "text-[#d4d4d8]";
  return (
    <div className={`py-[3px] pr-3 hover:bg-[#101014] ${indent ? "pl-9" : "pl-3"}`}>
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 w-[12ch] tabular-nums text-[#4d4d55]">{fmtTime(entry.ts)}</span>
        <span className={`shrink-0 w-[5.5ch] pt-px text-[10px] uppercase tracking-wide ${kind.cls}`}>{kind.label}</span>
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            className="shrink-0 w-3 text-[#555] hover:text-[#ededed] leading-[1.55]"
            title={open ? "Hide details" : "Show details"}
            aria-expanded={open}
          >
            {open ? "▼" : "▶"}
          </button>
        ) : (
          <span className="shrink-0 w-3" />
        )}
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          <span className={titleCls}>{item.title}</span>
          {item.detail ? <span className="text-[#6f6f78]"> · {item.detail}</span> : null}
        </span>
      </div>
      {open && expandable ? (
        <div className="mt-1 mb-1 ml-[calc(12ch+5.5ch+0.75rem+1.25rem)]">
          <div className="mb-1 whitespace-pre-wrap break-words text-[10.5px] text-[#666]">{entry.msg}</div>
          {hasPayload ? (
            <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded border border-[#1f1f23] bg-[#070708] px-2 py-1.5 text-[10.5px] text-[#8d8d95]">
              {formatPayload(entry.payload as string)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RunHeader({ run, collapsed, onToggle }: { run: RunBlock; collapsed: boolean; onToggle: () => void }) {
  const status = runStatusText(run);
  const counts = runCounts(run);
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-[#101014]"
      aria-expanded={!collapsed}
    >
      <span className="shrink-0 w-[12ch] tabular-nums text-[#4d4d55]">{fmtClock(run.startedAt)}</span>
      <span className="shrink-0 w-3 text-[#555]">{collapsed ? "▶" : "▼"}</span>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[run.status]}`} />
      <span className="truncate font-medium text-[#ededed]">{run.jigId}</span>
      <span className="shrink-0 text-[#6f6f78]">{run.dryRun ? "dry run" : run.runId !== undefined ? `run #${run.runId}` : "run"}</span>
      <span className={`shrink-0 ${run.status === "failed" ? "text-rose-300" : run.status === "running" ? "text-shimmer" : "text-[#8d8d95]"}`}>{status}</span>
      {run.error ? <span className="min-w-0 truncate text-rose-300/80">{run.error}</span> : null}
      {counts ? <span className="ml-auto shrink-0 pl-3 text-[#555]">{counts}</span> : null}
    </button>
  );
}

export function LogsSettings() {
  const [entries, setEntries] = useState<ServerLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [levelFilter, setLevelFilter] = useState<LogFilter["level"]>("all");
  const [verbose, setVerbose] = useState(false);
  const [query, setQuery] = useState("");
  const [clearing, setClearing] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [toggledRuns, setToggledRuns] = useState<Record<string, boolean>>({});

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled || paused) return;
      try {
        const { entries: next } = await fetchServerLogs(lastSeqRef.current);
        if (cancelled) return;
        if (next.length > 0) {
          lastSeqRef.current = next[next.length - 1].seq;
          const useful = next.filter(isOperationalLog);
          if (useful.length > 0) {
            setEntries((prev) => {
              const combined = [...prev, ...useful];
              return combined.length > 5000 ? combined.slice(combined.length - 5000) : combined;
            });
          }
        }
        setError((prev) => (prev === null ? prev : null));
      } catch (e) {
        const msg = (e as Error)?.message ?? "Failed to load logs";
        setError((prev) => (prev === msg ? prev : msg));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(tick, POLL_MS);
        }
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [paused]);

  // Grouping depends only on the entries; filtering is cheap and runs per render.
  const groups = useMemo(() => groupRuns(entries.map(describeLog)), [entries]);
  const visible = useMemo(
    () => filterGroups(groups, { level: levelFilter, query, verbose }),
    [groups, levelFilter, query, verbose]
  );

  useEffect(() => {
    if (!follow || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visible, follow]);

  const visibleRows = visible.reduce((n, g) => n + (g.type === "run" ? g.run.items.length : 1), 0);
  const visibleRuns = visible.filter((g) => g.type === "run").length;

  function isCollapsed(run: RunBlock): boolean {
    const toggled = toggledRuns[run.key];
    if (toggled !== undefined) return toggled;
    return run.status === "ok";
  }

  function toggleRun(key: string, current: boolean) {
    setToggledRuns((prev) => ({ ...prev, [key]: !current }));
  }

  function toggleExpanded(seq: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }

  async function onClear() {
    setClearing(true);
    try {
      await clearServerLogs();
      setEntries([]);
      setToggledRuns({});
      lastSeqRef.current = 0;
    } catch (e) {
      setError((e as Error)?.message ?? "Clear failed");
    } finally {
      setClearing(false);
    }
  }

  function onCopy() {
    navigator.clipboard?.writeText(exportText(visible)).catch(() => {});
  }

  function onDownload() {
    const blob = new Blob([exportText(visible)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jig-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function onScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollow(atBottom);
  }

  if (loading) return <LoadingState message="Loading server logs…" />;

  const segment = (active: boolean) =>
    `rounded px-2 py-1 text-[11px] font-medium transition-colors duration-150 ${active ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by jig, step, tool, model or error…"
          className="flex-1 min-w-[160px] rounded-md border border-[#1f1f23] bg-[#0d0d0f] px-2.5 py-1.5 text-[12px] text-[#ededed] placeholder:text-[#555] outline-none focus:border-emerald-500/40"
        />
        <div className="flex items-center gap-0.5 rounded-md border border-[#1f1f23] bg-[#0e0e10] p-0.5">
          {(["all", "warn", "error"] as const).map((l) => (
            <button key={l} onClick={() => setLevelFilter(l)} className={segment(levelFilter === l)}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 rounded-md border border-[#1f1f23] bg-[#0e0e10] p-0.5">
          <button onClick={() => setVerbose((v) => !v)} className={segment(verbose)} title="Show runner lifecycle, LLM requests and tool calls that already completed">
            verbose
          </button>
        </div>
        <Button onClick={() => setPaused((p) => !p)} variant="subtle" size="sm">
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button onClick={onCopy} variant="subtle" size="sm" disabled={visible.length === 0}>
          Copy
        </Button>
        <Button onClick={onDownload} variant="subtle" size="sm" disabled={visible.length === 0}>
          Download
        </Button>
        <Button onClick={onClear} variant="subtle" size="sm" disabled={clearing}>
          {clearing ? "Clearing…" : "Clear"}
        </Button>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-[60vh] min-h-[320px] overflow-y-auto rounded-lg border border-[#1f1f23] bg-[#0a0a0b] font-mono text-[11px] leading-[1.55]"
      >
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[#555]">
            {entries.length === 0
              ? "Nothing yet. Runs, steps, model calls and tool calls show up here as they happen."
              : "No matches."}
          </div>
        ) : (
          <div className="divide-y divide-[#14141680]">
            {visible.map((g) => {
              if (g.type === "entry") {
                const item = g.item;
                return (
                  <LogRow
                    key={item.entry.seq}
                    item={item}
                    indent={false}
                    open={expanded.has(item.entry.seq)}
                    onToggle={() => toggleExpanded(item.entry.seq)}
                  />
                );
              }
              const run = g.run;
              const collapsed = isCollapsed(run);
              return (
                <div key={run.key} className={run.status === "failed" ? "bg-rose-500/[0.03]" : ""}>
                  <RunHeader run={run} collapsed={collapsed} onToggle={() => toggleRun(run.key, collapsed)} />
                  {!collapsed && run.items.length > 0 ? (
                    <div className="ml-[calc(12ch+0.75rem+0.375rem)] border-l border-[#1f1f23] pb-1">
                      {run.items.map((item) => (
                        <LogRow
                          key={item.entry.seq}
                          item={item}
                          indent
                          open={expanded.has(item.entry.seq)}
                          onToggle={() => toggleExpanded(item.entry.seq)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-[10px] text-[#555]">
        <span>
          {visibleRuns} run{visibleRuns === 1 ? "" : "s"} · {visibleRows} of {entries.length} events
          {paused ? " · paused" : ""}
          {!follow ? " · scroll to bottom to resume follow" : ""}
        </span>
        <span>Finished runs start collapsed · polling every 2s</span>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/button";
import { LoadingState, Notice } from "@/components/state-panel";
import { clearServerLogs, fetchServerLogs, type ServerLogEntry } from "@/lib/api";

const POLL_MS = 2000;
const LEVEL_COLOR: Record<ServerLogEntry["level"], string> = {
  info: "text-[#9a9aa3]",
  warn: "text-amber-300",
  error: "text-rose-300",
};

function isOperationalLog(entry: ServerLogEntry): boolean {
  const msg = entry.msg.trim();
  if (entry.level === "error") return true;
  if (/^\[run\]\s/.test(msg)) return true;
  if (/^\[scheduler\]\s/.test(msg) && /(started|done|failed|error|catch-up|marked|skipped|triggered)/i.test(msg)) return true;
  if (/^\[connection\]\s/.test(msg)) return true;
  if (/^\[composio\]\s/.test(msg) && /(connected|discovered|failed|error)/i.test(msg)) return true;
  if (/^\[webhook\]\s/.test(msg)) return true;
  if (/^API error:/i.test(msg)) return true;
  return false;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export function LogsSettings() {
  const [entries, setEntries] = useState<ServerLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [levelFilter, setLevelFilter] = useState<"all" | "warn" | "error">("all");
  const [query, setQuery] = useState("");
  const [clearing, setClearing] = useState(false);

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
          if (useful.length === 0) return;
          setEntries((prev) => {
            const combined = [...prev, ...useful];
            // Ring buffer on the client side too — trim if we grow unbounded
            return combined.length > 5000 ? combined.slice(combined.length - 5000) : combined;
          });
        }
        // Avoid re-rendering just to set error back to null it already was
        setError((prev) => (prev === null ? prev : null));
      } catch (e) {
        const msg = (e as Error)?.message ?? "Failed to load logs";
        // Dedupe identical error text so repeated failures don't cause a
        // flicker of re-renders. React bails on === state updates.
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

  useEffect(() => {
    if (!follow || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, follow]);

  const q = query.trim().toLowerCase();
  const filtered = entries.filter((e) => {
    if (levelFilter === "warn" && e.level === "info") return false;
    if (levelFilter === "error" && e.level !== "error") return false;
    if (q && !e.msg.toLowerCase().includes(q)) return false;
    return true;
  });

  async function onClear() {
    setClearing(true);
    try {
      await clearServerLogs();
      setEntries([]);
      lastSeqRef.current = 0;
    } catch (e) {
      setError((e as Error)?.message ?? "Clear failed");
    } finally {
      setClearing(false);
    }
  }

  function onCopy() {
    const text = filtered
      .map((e) => `${new Date(e.ts).toISOString()} [${e.level}] ${e.msg}`)
      .join("\n");
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  function onDownload() {
    const text = filtered
      .map((e) => `${new Date(e.ts).toISOString()} [${e.level}] ${e.msg}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="flex-1 min-w-[160px] rounded-md border border-[#1f1f23] bg-[#0d0d0f] px-2.5 py-1.5 text-[12px] text-[#ededed] placeholder:text-[#555] outline-none focus:border-emerald-500/40"
        />
        <div className="flex items-center gap-0.5 rounded-md border border-[#1f1f23] bg-[#0e0e10] p-0.5">
          {(["all", "warn", "error"] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLevelFilter(l)}
              className={`rounded px-2 py-1 text-[11px] font-medium transition-colors duration-150 ${levelFilter === l ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`}
            >
              {l}
            </button>
          ))}
        </div>
        <Button onClick={() => setPaused((p) => !p)} variant="subtle" size="sm">
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button onClick={onCopy} variant="subtle" size="sm" disabled={filtered.length === 0}>
          Copy
        </Button>
        <Button onClick={onDownload} variant="subtle" size="sm" disabled={filtered.length === 0}>
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
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[#555]">
            {entries.length === 0 ? "No operational logs captured yet." : "No matches."}
          </div>
        ) : (
          <div className="divide-y divide-[#14141680]">
            {filtered.map((e) => (
              <div key={e.seq} className="flex gap-3 px-3 py-1 hover:bg-[#101014]">
                <span className="shrink-0 text-[#555]">{fmtTime(e.ts)}</span>
                <span className={`shrink-0 w-10 ${LEVEL_COLOR[e.level]}`}>{e.level}</span>
                {e.source ? (
                  <span className="shrink-0 w-16 text-[#666]" title={`process: ${e.source}`}>{e.source}</span>
                ) : null}
                <pre className="whitespace-pre-wrap break-words text-[#c7c7cd] m-0">{e.msg}</pre>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-[10px] text-[#555]">
        <span>
          {filtered.length} of {entries.length} entries
          {paused ? " · paused" : ""}
          {!follow ? " · scroll to bottom to resume follow" : ""}
        </span>
        <span>Operational events only · polling every 2s</span>
      </div>
    </div>
  );
}

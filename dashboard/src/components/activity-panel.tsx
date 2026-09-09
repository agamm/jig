"use client";

import { useEffect, useMemo, useState } from "react";
import { useActivity } from "@/lib/swr";
import type { ActivityDay, ActivityReport } from "@shared/api";

/**
 * Runs and model spend per day at the top of the jigs page.
 *
 * Two panels on one time axis, never two y-axes: runs as stacked bars
 * (succeeded, failed), spend as a line with a soft area under it. Spend stays
 * hidden until a run in the window has a recorded cost, so an instance that
 * predates cost accounting shows runs alone rather than a flat $0 line.
 */

type Range = "7d" | "30d" | "90d";
const RANGES: Range[] = ["7d", "30d", "90d"];
const RANGE_KEY = "jig-activity-range";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const OK = "#34d399";
const FAIL = "#f43f5e";
const SPEND = "#8b7cf6";

const money = (v: number) => (v > 0 && v < 0.01 ? "<$0.01" : `$${v.toFixed(2)}`);

/** "2026-09-08" -> parts, without letting the browser's timezone shift the day. */
function parts(date: string): { y: number; m: number; d: number; dow: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}
const shortDate = (date: string) => { const p = parts(date); return `${MONTHS[p.m - 1]} ${p.d}`; };
const longDate = (date: string) => { const p = parts(date); return `${DAYS[p.dow]}, ${MONTHS[p.m - 1]} ${p.d}`; };

function useRange(): [Range, (r: Range) => void] {
  const [range, setRange] = useState<Range>("30d");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(RANGE_KEY);
      if (stored === "7d" || stored === "30d" || stored === "90d") setRange(stored);
    } catch { /* storage unavailable: keep the default */ }
  }, []);
  const update = (r: Range) => {
    setRange(r);
    try { window.localStorage.setItem(RANGE_KEY, r); } catch { /* fine */ }
  };
  return [range, update];
}

export function ActivityPanel() {
  const [range, setRange] = useRange();
  const { data, error } = useActivity(range);
  const label = range === "7d" ? "Last 7 days" : range === "30d" ? "Last 30 days" : "Last 90 days";

  return (
    <section className="rounded-xl border border-[#1f1f23] bg-[#0b0b0d] overflow-hidden" aria-label={`Runs and spend, ${label.toLowerCase()}`}>
      <div className="flex items-center justify-between px-4 pt-3">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">{label}</span>
        <div className="flex gap-0.5 rounded-md border border-[#1f1f23] bg-[#111113] p-0.5" role="tablist" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r}
              role="tab"
              aria-selected={r === range}
              onClick={() => setRange(r)}
              className={`rounded px-2 py-0.5 font-mono text-[11px] transition-colors ${
                r === range ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#666] hover:text-[#9a9aa3]"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="px-4 py-4 text-[12px] text-[#fb7185]">Could not load activity: {error.message}</p>
      ) : !data ? (
        <div className="h-[220px]" />
      ) : (
        <ActivityBody report={data} />
      )}
    </section>
  );
}

function Tile({ label, value, delta, tone }: { label: string; value: string; delta: string; tone?: "ok" | "fail" | "spend" }) {
  const toneClass = tone === "ok" ? "text-emerald-400" : tone === "fail" ? "text-rose-400" : tone === "spend" ? "text-[#a99bff]" : "text-[var(--text-dim)]";
  return (
    <div className="py-2 pr-4 [&+&]:border-l [&+&]:border-[#1f1f23] [&+&]:pl-4">
      <div className="text-[11px] text-[var(--text-dim)]">{label}</div>
      <div className="mt-0.5 font-mono text-[22px] font-medium tracking-[-0.02em] tabular-nums text-[#ededed]">{value}</div>
      <div className={`mt-0.5 font-mono text-[11px] tabular-nums ${toneClass}`}>{delta}</div>
    </div>
  );
}

function ActivityBody({ report }: { report: ActivityReport }) {
  const { days, totals, previous } = report;
  const showSpend = totals.costKnown;
  const successRate = totals.runs ? Math.round((100 * totals.ok) / totals.runs) : null;
  const runsDelta = previous ? totals.runs - previous.runs : null;
  const spendDelta = previous ? totals.costUsd - previous.costUsd : null;
  const busiest = days.reduce((m, d) => Math.max(m, d.costUsd), 0);
  const span = `${days.length - 1}d`;

  return (
    <>
      <div className={`grid px-4 pt-2 ${showSpend ? "grid-cols-2 md:grid-cols-4" : "grid-cols-2"}`}>
        <Tile
          label="Runs"
          value={String(totals.runs)}
          delta={runsDelta == null ? `in the last ${span}` : `${runsDelta >= 0 ? "+" : ""}${runsDelta} vs previous ${span}`}
          tone={runsDelta != null && runsDelta > 0 ? "ok" : undefined}
        />
        <Tile
          label="Succeeded"
          value={successRate == null ? "-" : `${successRate}%`}
          delta={totals.fail ? `${totals.fail} failed` : totals.runs ? "no failures" : "no runs yet"}
          tone={totals.fail ? "fail" : undefined}
        />
        {showSpend && (
          <Tile
            label="Spend"
            value={money(totals.costUsd)}
            delta={spendDelta == null ? `model calls, last ${span}` : `${spendDelta >= 0 ? "+" : "-"}${money(Math.abs(spendDelta))} vs previous ${span}`}
            tone="spend"
          />
        )}
        {showSpend && (
          <Tile
            label="Per run"
            value={totals.runs ? money(totals.costUsd / totals.runs) : "-"}
            delta={`${money(busiest)} on the busiest day`}
          />
        )}
      </div>

      {totals.runs === 0 ? (
        <p className="px-4 pb-4 pt-3 text-[12px] text-[var(--text-dim)]">No runs in this window yet. Runs land here as they happen.</p>
      ) : (
        <Chart days={days} showSpend={showSpend} />
      )}

      <div className="flex items-center gap-4 px-4 pb-3 pt-1 text-[11px] text-[var(--text-dim)]">
        <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-[2px]" style={{ background: OK }} />succeeded</span>
        <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-[2px]" style={{ background: FAIL }} />failed</span>
        {showSpend ? (
          <span className="flex items-center gap-1.5"><i className="h-[2px] w-3 rounded-[1px]" style={{ background: SPEND }} />model spend (OpenRouter, USD)</span>
        ) : (
          <span className="ml-auto font-mono text-[10px] text-[var(--text-faint)]">spend appears once a run records its model cost</span>
        )}
      </div>
    </>
  );
}

function Chart({ days, showSpend }: { days: ActivityDay[]; showSpend: boolean }) {
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  const geo = useMemo(() => {
    const W = 1000, L = 52, R = 44, top = 20, runsH = 100, gap = showSpend ? 30 : 0, spendH = showSpend ? 84 : 0, axisH = 22;
    const H = top + runsH + gap + spendH + axisH;
    const plotW = W - L - R;
    const slot = plotW / days.length;
    const bw = Math.max(3, Math.min(18, slot * 0.56));
    const x = (i: number) => L + (i + 0.5) * slot;
    const maxRuns = Math.max(4, ...days.map((d) => d.ok + d.fail));
    const runsY = (v: number) => top + runsH - (v / maxRuns) * runsH;
    const maxSpend = Math.max(0.01, ...days.map((d) => d.costUsd)) * 1.15;
    const spendTop = top + runsH + gap;
    const spendY = (v: number) => spendTop + spendH - (v / maxSpend) * spendH;
    return { W, L, R, top, runsH, gap, spendH, axisH, H, slot, bw, x, maxRuns, runsY, maxSpend, spendTop, spendY };
  }, [days, showSpend]);

  const { W, L, R, top, H, slot, bw, x, maxRuns, runsY, maxSpend, spendTop, spendY, axisH } = geo;
  const roundedTop = (cx: number, y0: number, y1: number) => {
    const r = Math.min(3, Math.max(0, (y0 - y1) / 2)), xl = cx - bw / 2, xr = cx + bw / 2;
    return `M${xl},${y0} V${y1 + r} Q${xl},${y1} ${xl + r},${y1} H${xr - r} Q${xr},${y1} ${xr},${y1 + r} V${y0} Z`;
  };
  const labelEvery = days.length > 45 ? 14 : days.length > 10 ? 7 : 1;
  const linePts = days.map((d, i) => `${x(i)},${spendY(d.costUsd)}`);
  const last = days[days.length - 1];

  return (
    <div className="relative px-2 pt-1">
      <span className="pointer-events-none absolute left-[60px] text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-faint)]" style={{ top: 4 }}>Runs per day</span>
      {showSpend && (
        <span className="pointer-events-none absolute left-[60px] text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-faint)]" style={{ top: `${(spendTop - 12) / H * 100}%` }}>Model spend per day</span>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" role="img" aria-label="Runs per day and model spend per day">
        <defs>
          <linearGradient id="activity-spend-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={SPEND} stopOpacity="0.28" />
            <stop offset="1" stopColor={SPEND} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <g stroke="#1a1a1e" strokeWidth="1">
          {[0, 0.5, 1].map((f) => <line key={`rg${f}`} x1={L} x2={W - R} y1={runsY(maxRuns * f)} y2={runsY(maxRuns * f)} />)}
          {showSpend && [0.5, 1].map((f) => <line key={`sg${f}`} x1={L} x2={W - R} y1={spendY(maxSpend * f / 1.15)} y2={spendY(maxSpend * f / 1.15)} />)}
        </g>
        <g fill="#5f5f66" fontFamily="var(--font-geist-mono), ui-monospace, monospace" fontSize="10">
          <text x={L - 8} y={runsY(maxRuns) + 4} textAnchor="end">{maxRuns}</text>
          <text x={L - 8} y={runsY(0) + 4} textAnchor="end">0</text>
          {showSpend && <text x={L - 8} y={spendY(maxSpend / 1.15) + 4} textAnchor="end">{money(maxSpend / 1.15)}</text>}
          {showSpend && <text x={L - 8} y={spendY(0) + 4} textAnchor="end">$0</text>}
          {days.map((d, i) => (i === days.length - 1 || (days.length - 1 - i) % labelEvery === 0) && (days.length - 1 - i !== 0 || true) ? (
            <text key={d.date} x={x(i)} y={H - 6} textAnchor="middle">{i === days.length - 1 ? "today" : shortDate(d.date)}</text>
          ) : null)}
        </g>
        <g>
          {days.map((d, i) => {
            const cx = x(i), y0 = runsY(0);
            const okTop = runsY(d.ok);
            const failBase = d.ok > 0 ? okTop - 2 : y0; // 2px gap between the stacked segments
            const failTop = runsY(d.ok + d.fail) - (d.ok > 0 ? 2 : 0);
            return (
              <g key={d.date}>
                {d.ok > 0 && (d.fail > 0
                  ? <rect fill={OK} x={cx - bw / 2} y={okTop} width={bw} height={y0 - okTop} />
                  : <path fill={OK} d={roundedTop(cx, y0, okTop)} />)}
                {d.fail > 0 && <path fill={FAIL} d={roundedTop(cx, failBase, failTop)} />}
              </g>
            );
          })}
        </g>
        {showSpend && (
          <>
            <path fill="url(#activity-spend-fill)" d={`M${x(0)},${spendY(0)} L${linePts.join(" L")} L${x(days.length - 1)},${spendY(0)} Z`} />
            <path fill="none" stroke={SPEND} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" d={`M${linePts.join(" L")}`} />
            <circle fill={SPEND} stroke="#0b0b0d" strokeWidth="2" r="4" cx={x(days.length - 1)} cy={spendY(last.costUsd)} />
            <text fill="#ededed" fontFamily="var(--font-geist-mono), ui-monospace, monospace" fontSize="11" fontWeight="500" x={x(days.length - 1) + 8} y={spendY(last.costUsd) + 4}>{money(last.costUsd)}</text>
          </>
        )}
        {hover && <line stroke="#2a2a2f" strokeDasharray="2 3" x1={x(hover.i)} x2={x(hover.i)} y1={top - 6} y2={H - axisH} />}
        <g>
          {days.map((d, i) => (
            <rect
              key={d.date}
              fill="transparent"
              className="cursor-crosshair"
              x={x(i) - slot / 2}
              y={top - 6}
              width={slot}
              height={H - top - axisH + 6}
              onMouseMove={(e) => {
                const rect = (e.currentTarget.ownerSVGElement?.parentElement as HTMLElement | null)?.getBoundingClientRect();
                if (rect) setHover({ i, x: e.clientX - rect.left, y: e.clientY - rect.top });
              }}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </g>
      </svg>
      {hover && <Tooltip day={days[hover.i]} x={hover.x} y={hover.y} showSpend={showSpend} />}
    </div>
  );
}

function Tooltip({ day, x, y, showSpend }: { day: ActivityDay; x: number; y: number; showSpend: boolean }) {
  const flip = typeof window !== "undefined" && x + 230 > (document.body.clientWidth - 220);
  return (
    <div
      className="pointer-events-none absolute z-20 min-w-[190px] rounded-lg border border-[#2a2a2e] bg-[#141417] px-2.5 py-2 text-[11px] shadow-lg"
      style={{ left: flip ? x - 210 : x + 16, top: Math.max(4, y - 40) }}
    >
      <div className="mb-1.5 font-mono text-[#9a9aa3]">{longDate(day.date)}</div>
      <Row swatch={OK} label="succeeded" value={String(day.ok)} />
      <Row swatch={FAIL} label="failed" value={String(day.fail)} />
      {showSpend && <Row swatch={SPEND} label="spend" value={money(day.costUsd)} />}
      {day.byJig.length > 0 && (
        <div className="mt-1.5 border-t border-[#1f1f23] pt-1.5">
          {day.byJig.slice(0, 6).map((j) => (
            <div key={j.jigId} className="flex justify-between gap-3 py-px tabular-nums">
              <span className="truncate text-[var(--text-dim)]">{j.jigId}</span>
              <span className="font-mono text-[#ededed]">
                {j.fail ? <span className="text-rose-400">{j.fail} fail</span> : null}
                {j.fail && (showSpend || j.ok) ? " · " : ""}
                {showSpend ? money(j.costUsd) : `${j.ok} ok`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ swatch, label, value }: { swatch: string; label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 py-px tabular-nums">
      <span className="flex items-center gap-1.5 text-[#9a9aa3]"><i className="inline-block h-[7px] w-[7px] rounded-[2px]" style={{ background: swatch }} />{label}</span>
      <span className="font-mono text-[#ededed]">{value}</span>
    </div>
  );
}

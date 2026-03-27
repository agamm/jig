"use client";

import { useState, useMemo, useCallback } from "react";
import type { Jig } from "@/types/jig";
import { ConnectionTag } from "@/components/connection-tag";
import { HighlightedCode } from "@/components/highlighted-code";
import { RunSteps, type RunStep } from "@/components/run-steps";
import { useJigRun } from "@/hooks/use-jig-run";
import { TRIGGER_SUGGESTIONS } from "@/mock/mock-data";
import { formatElapsed } from "@/lib/format";

const statusDot = (s: string) =>
  s === "healthy" ? "bg-emerald-400" : s === "attention" ? "bg-amber-400" : "bg-rose-400";

export function JigDetailPane({ jig, selectedEntity, onClose, onEdit, expanded = false, onToggleExpand }: {
  jig: Jig;
  selectedEntity: string | null;
  onClose: () => void;
  onEdit?: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const [detailTab, setDetailTab] = useState<"steps" | "code">("steps");
  const [editingTrigger, setEditingTrigger] = useState(false);
  const [triggerValue, setTriggerValue] = useState(jig.settings.trigger);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);

  const { mode, liveSteps, completedTools, activeTools, startRun, dismiss, cancelRun, isRunning } = useJigRun(jig.id, selectedEntity);
  const [recompiling, setRecompiling] = useState(false);
  const hasParams = jig.params && Object.keys(jig.params).length > 0;
  const [paramValues, setParamValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(jig.params ?? {}).map(([k, v]) => [k, ""]))
  );

  const recompile = useCallback(async () => {
    setRecompiling(true);
    try {
      await fetch(`/api/jigs/${encodeURIComponent(jig.id)}/recompile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: selectedEntity ?? undefined }),
      });
      window.location.reload();
    } catch {
      setRecompiling(false);
    }
  }, [jig.id, selectedEntity]);

  // Always show derived steps as-is. Run status is shown at agent-group level,
  // not per-step (agent calls tools nondeterministically — can't map to steps).
  // After completion, attach output to the last step.
  const runSteps: RunStep[] = useMemo(() => {
    const derived: RunStep[] = jig.steps.map(s => ({
      num: s.num, name: s.name, desc: s.desc,
      connections: s.connections, tools: s.tools, agentGroup: s.agentGroup,
    }));

    if (derived.length === 0) return derived;

    // After run completes: mark all as success/fail, attach output to last step
    if (mode.type === "done") {
      const runOutput = liveSteps.find(s => s.name === "Result")?.output;
      return derived.map((s, i) => ({
        ...s,
        status: mode.status as RunStep["status"],
        time: i === 0 ? formatElapsed(mode.elapsed) : undefined,
        output: i === derived.length - 1 ? runOutput : undefined,
      }));
    }

    // During run: the first step in each agent group is "running".
    // Other agent steps stay as-is. Non-agent steps are pending.
    if (mode.type === "running") {
      const seenGroups = new Set<string>();
      return derived.map(s => {
        if (s.agentGroup) {
          if (!seenGroups.has(s.agentGroup)) {
            seenGroups.add(s.agentGroup);
            return { ...s, status: "running" as const };
          }
          return s;
        }
        return { ...s, status: "pending" as const };
      });
    }

    return derived;
  }, [jig.steps, mode, liveSteps, completedTools, activeTools]);

  const handleRun = (dryRun: boolean) => {
    setDetailTab("steps");
    startRun(dryRun, hasParams ? paramValues : undefined);
  };

  return (
    <aside
      className={`flex shrink-0 flex-col border-l border-[#1f1f23] bg-[#0e0e10] overflow-hidden transition-all duration-200 ${expanded ? "w-full" : "w-[48%]"}`}
      style={{ animation: "slide-in-right 0.2s ease" }}
    >
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-4 gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-[#ededed] whitespace-nowrap">
            {jig.name}
            {selectedEntity && <span className="text-[#555]"> &mdash; {selectedEntity}</span>}
          </h2>
          <span className={`shrink-0 h-1.5 w-1.5 rounded-full ${statusDot(jig.status)}`} />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={onEdit} className="rounded-md border border-[#1f1f23] bg-[#111113] px-2.5 py-1 text-[11px] text-[#888] transition-colors duration-150 hover:bg-[#1a1a1d]" title="Edit">&#9998;</button>
          {onToggleExpand && (
            <button
              onClick={onToggleExpand}
              className="rounded-md border border-[#1f1f23] bg-[#111113] px-2 py-1 text-[11px] text-[#555] transition-colors duration-150 hover:text-[#888] hover:bg-[#1a1a1d]"
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? "\u21E5" : "\u21E4"}
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-md border border-[#1f1f23] bg-[#111113] px-2 py-1 text-[11px] text-[#555] transition-colors duration-150 hover:text-[#888] hover:bg-[#1a1a1d]"
          >
            &#10005;
          </button>
        </div>
      </div>

      {/* Stale warning */}
      {jig.stale && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2" style={{ animation: "fade-up 0.15s ease" }}>
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
          <span className="text-[11px] text-amber-300 flex-1">Code changed outside the dashboard. Steps may be outdated.</span>
          <button onClick={recompile} disabled={recompiling} className="text-[10px] text-amber-400 hover:text-amber-300 transition-colors font-medium disabled:opacity-50">
            {recompiling ? "Compiling…" : "Re-compile"}
          </button>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* Steps / Code toggle + Run buttons */}
        <div className="flex items-center justify-between">
          <div className="flex gap-0.5 rounded-lg border border-[#1f1f23] bg-[#0a0a0b] p-0.5 w-fit">
            <button onClick={() => setDetailTab("steps")} className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors duration-150 ${detailTab === "steps" ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`}>Steps</button>
            <button onClick={() => setDetailTab("code")} className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors duration-150 ${detailTab === "code" ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`}>Code</button>
          </div>
          <div className="flex items-center gap-1.5">
            {isRunning ? (
              <button
                onClick={cancelRun}
                className="rounded-md border border-rose-600/30 bg-rose-600/10 px-2.5 py-1 text-[10px] font-medium text-rose-400 transition-all duration-150 hover:bg-rose-600/20 active:scale-95"
              >
                Cancel
              </button>
            ) : (
              <>
                <button
                  onClick={() => handleRun(false)}
                  className="rounded-md bg-emerald-600 px-2.5 py-1 text-[10px] font-medium text-white transition-all duration-150 hover:bg-emerald-500 active:scale-95"
                >
                  &#9654; Run
                </button>
                <button
                  onClick={() => handleRun(true)}
                  className="rounded-md border border-emerald-600/30 bg-emerald-600/10 px-2.5 py-1 text-[10px] font-medium text-emerald-400 transition-all duration-150 hover:bg-emerald-600/20 active:scale-95"
                  title="Read-only — no writes"
                >
                  Dry Run
                </button>
              </>
            )}
          </div>
        </div>

        {/* Parameter inputs */}
        {hasParams && (
          <div className="rounded-lg border border-[#1f1f23] bg-[#111113] p-3 space-y-2">
            {Object.entries(jig.params!).map(([key, hint]) => (
              <div key={key} className="flex items-center gap-2">
                <label className="text-[11px] text-[#888] w-24 shrink-0 font-mono">{key}</label>
                <input
                  type="text"
                  value={paramValues[key] ?? ""}
                  onChange={(e) => setParamValues(prev => ({ ...prev, [key]: e.target.value }))}
                  placeholder={hint || key}
                  className="flex-1 rounded-md border border-[#1f1f23] bg-[#0a0a0b] px-2.5 py-1.5 text-[11px] text-[#ededed] placeholder:text-[#444] outline-none focus:border-[#2a2a2e] transition-colors"
                />
              </div>
            ))}
          </div>
        )}

        {/* Steps or Code */}
        {detailTab === "steps" ? (
          <div key="steps" className="flip-enter">
            <RunSteps
              steps={runSteps}
              mode={mode}
              onClear={dismiss}
              completedTools={completedTools}
              activeTools={activeTools}
              emptyAction={
                <button
                  onClick={recompile}
                  disabled={recompiling}
                  className="mt-2 text-[10px] text-blue-400 hover:text-blue-300 transition-colors font-medium disabled:opacity-50"
                >
                  {recompiling ? "Deriving…" : "Derive steps"}
                </button>
              }
            />
          </div>
        ) : (
          <div key="code" className="rounded-lg border border-[#1f1f23] bg-[#111113] p-4 font-mono overflow-x-auto flip-enter">
            <HighlightedCode code={jig.code} />
          </div>
        )}

        {/* Trigger */}
        <div>
          <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Trigger</h3>
          {editingTrigger ? (
            <div className="rounded-lg border border-blue-500/30 bg-[#111113] p-3 space-y-2" style={{ animation: "fade-up 0.15s ease" }}>
              <input
                type="text"
                value={triggerValue}
                onChange={(e) => setTriggerValue(e.target.value)}
                className="w-full rounded-md border border-[#1f1f23] bg-[#0a0a0b] px-3 py-1.5 text-[12px] text-[#ededed] outline-none focus:border-blue-500/50 transition-colors duration-150"
                autoFocus
              />
              <p className="text-[10px] text-[#555]">Type naturally, e.g. &quot;every friday at 9am&quot;</p>
              <div className="flex flex-wrap gap-1.5">
                {TRIGGER_SUGGESTIONS.map(s => (
                  <button key={s} onClick={() => setTriggerValue(s)} className="rounded-md border border-[#1f1f23] bg-[#0a0a0b] px-2 py-1 text-[10px] text-[#888] transition-colors duration-150 hover:border-[#2a2a2e] hover:text-[#ededed]">
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5 pt-1">
                <button onClick={() => setEditingTrigger(false)} className="rounded-md bg-blue-600 px-2.5 py-1 text-[10px] font-medium text-white transition-colors duration-150 hover:bg-blue-500">Save</button>
                <button onClick={() => { setEditingTrigger(false); setTriggerValue(jig.settings.trigger); }} className="rounded-md border border-[#1f1f23] px-2.5 py-1 text-[10px] text-[#555] transition-colors duration-150 hover:text-[#888]">Cancel</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => { setEditingTrigger(true); setTriggerValue(jig.settings.trigger); }}
              className="group inline-flex items-center gap-2 rounded-lg border border-transparent hover:border-[#2a2a2e] hover:bg-[#151517] px-3 py-2 text-left transition-all duration-150"
            >
              <span className="text-[12px] font-mono text-[#ccc]">{jig.settings.trigger || "No trigger"}</span>
              <span className="text-[10px] text-[#333] opacity-0 group-hover:opacity-100 transition-opacity duration-150">&#9998; edit</span>
            </button>
          )}
        </div>

        {/* Runs */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider">Runs</h3>
            <span className="text-[10px] text-[#444]">{jig.runs.length} total</span>
          </div>
          <div className="rounded-lg border border-[#1f1f23] bg-[#111113] divide-y divide-[#1a1a1d] max-h-[300px] overflow-y-auto">
            {jig.runs.slice(0, 10).map((run, i) => {
              const resultStep = run.steps?.find(s => s.output);
              const outputPreview = resultStep?.output?.slice(0, 80);
              const date = new Date(run.date);
              const isToday = new Date().toDateString() === date.toDateString();
              const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
              const dateStr = isToday ? `Today ${timeStr}` : date.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ` ${timeStr}`;

              return (
                <div key={i}>
                  <button
                    onClick={() => setExpandedRun(expandedRun === i ? null : i)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-[#151517]"
                  >
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] ${run.status === "success" ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400"}`}>
                      {run.status === "success" ? "✓" : "✗"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-[#ccc]">{dateStr}</span>
                        <span className="text-[10px] font-mono text-[#555]">{run.duration}</span>
                      </div>
                      {outputPreview && expandedRun !== i && (
                        <p className="text-[9px] text-[#444] truncate mt-0.5">{outputPreview}…</p>
                      )}
                    </div>
                    <span className={`text-[9px] text-[#333] transition-transform duration-150 shrink-0 ${expandedRun === i ? "rotate-90" : ""}`}>&#9656;</span>
                  </button>
                  {expandedRun === i && (
                    <div className="border-t border-[#1a1a1d] px-3 py-2.5" style={{ animation: "fade-up 0.15s ease" }}>
                      {resultStep?.output ? (
                        <pre className="text-[10px] text-[#888] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">{resultStep.output}</pre>
                      ) : (
                        <p className="text-[10px] text-[#555] italic">No output recorded</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Costs & Usage */}
        {jig.costMonth && (
          <div>
            <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Costs &amp; Usage</h3>
            <div className="grid grid-cols-4 gap-2">
              <div className="rounded-md bg-[#111113] border border-[#1f1f23] px-2.5 py-2">
                <p className="text-[13px] font-semibold text-[#ededed]">{jig.costMonth}</p>
                <p className="text-[10px] text-[#555]">this month</p>
              </div>
              <div className="rounded-md bg-[#111113] border border-[#1f1f23] px-2.5 py-2">
                <p className="text-[13px] font-semibold text-[#ededed]">{jig.costLifetime || "\u2014"}</p>
                <p className="text-[10px] text-[#555]">lifetime</p>
              </div>
              <div className="rounded-md bg-[#111113] border border-[#1f1f23] px-2.5 py-2">
                <p className="text-[13px] font-semibold text-[#ededed]">{jig.runs.length}</p>
                <p className="text-[10px] text-[#555]">total runs</p>
              </div>
              <div className="rounded-md bg-[#111113] border border-[#1f1f23] px-2.5 py-2">
                <p className="text-[13px] font-semibold text-[#ededed]">
                  {jig.runs.length > 0 ? `$${(parseFloat((jig.costLifetime || "0").replace("$", "")) / jig.runs.length).toFixed(3)}` : "\u2014"}
                </p>
                <p className="text-[10px] text-[#555]">avg/run</p>
              </div>
            </div>
          </div>
        )}

        {/* Connections */}
        <div>
          <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Connections</h3>
          <div className="flex flex-wrap gap-1.5">
            {jig.settings.connections.map(c => (
              <ConnectionTag key={c} name={c} />
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

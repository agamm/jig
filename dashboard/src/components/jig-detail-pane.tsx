"use client";

import { useState, useCallback } from "react";
import type { Jig, RunEntry } from "@/types/jig";
import { ConnectionTag } from "@/components/connection-tag";
import { HighlightedCode } from "@/components/highlighted-code";
import { StepList } from "@/components/step-list";
import { TRIGGER_SUGGESTIONS } from "@/mock/mock-data";

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
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [runningId, setRunningId] = useState<number | null>(null);
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "success" | "fail">("idle");
  const [runError, setRunError] = useState<string | null>(null);
  const [runDryRun, setRunDryRun] = useState(false);
  const [runElapsed, setRunElapsed] = useState(0);
  const [liveSteps, setLiveSteps] = useState<{ label: string; status: string; time: string; output?: string }[]>([]);

  const startRun = useCallback(async (dryRun: boolean) => {
    setRunStatus("running");
    setRunError(null);
    setRunDryRun(dryRun);
    setRunElapsed(0);
    setLiveSteps([]);
    setExpandedStep(null);
    setDetailTab("steps"); // Switch to steps tab to show progress
    const startTime = Date.now();

    // Tick elapsed every second while running
    const timer = setInterval(() => {
      setRunElapsed(Math.round((Date.now() - startTime) / 1000));
    }, 1000);

    try {
      const res = await fetch(`/api/jigs/${encodeURIComponent(jig.id)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: selectedEntity ?? undefined,
          dryRun,
        }),
      });
      if (!res.ok) {
        clearInterval(timer);
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        setRunStatus("fail");
        setRunError(err.error ?? `HTTP ${res.status}`);
        return;
      }
      const { runId } = await res.json();
      setRunningId(runId);

      // Poll for completion
      const poll = async () => {
        for (let i = 0; i < 300; i++) { // max 5 min
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const pollRes = await fetch(`/api/runs/${runId}`);
            if (!pollRes.ok) continue;
            const run = await pollRes.json();
            setLiveSteps(run.steps ?? []);
            if (run.status === "success" || run.status === "fail") {
              clearInterval(timer);
              setRunElapsed(Math.round((Date.now() - startTime) / 1000));
              setRunStatus(run.status);
              if (run.error) setRunError(run.error);
              if (run.durationMs) setRunElapsed(Math.round(run.durationMs / 1000));
              setRunningId(null);
              return;
            }
          } catch {}
        }
        clearInterval(timer);
        setRunStatus("fail");
        setRunError("Timed out waiting for completion");
        setRunningId(null);
      };
      poll();
    } catch (e: any) {
      clearInterval(timer);
      setRunStatus("fail");
      setRunError(e?.message ?? "Unknown error");
    }
  }, [jig.id, selectedEntity]);

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
          <button
            onClick={async () => {
              await fetch(`/api/jigs/${encodeURIComponent(jig.id)}/recompile`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ entity: selectedEntity ?? undefined }),
              });
              window.location.reload();
            }}
            className="text-[10px] text-amber-400 hover:text-amber-300 transition-colors font-medium"
          >
            Re-compile
          </button>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* Steps / Code toggle */}
        <div className="flex gap-0.5 rounded-lg border border-[#1f1f23] bg-[#0a0a0b] p-0.5 w-fit">
          <button onClick={() => setDetailTab("steps")} className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors duration-150 ${detailTab === "steps" ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`}>Steps</button>
          <button onClick={() => setDetailTab("code")} className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors duration-150 ${detailTab === "code" ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`}>Code</button>
        </div>

        {/* Steps or Code */}
        {detailTab === "steps" ? (
          <div key="steps" className="flip-enter space-y-2">
            {/* Run status bar — shows during/after a run */}
            {runStatus !== "idle" && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#111113] border border-[#1f1f23]">
                {runStatus === "running" && <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse shrink-0" />}
                {runStatus === "success" && <span className="h-2 w-2 rounded-full bg-emerald-400 shrink-0" />}
                {runStatus === "fail" && <span className="h-2 w-2 rounded-full bg-rose-400 shrink-0" />}
                <span className="text-[11px] font-medium text-[#ededed] flex-1">
                  {runStatus === "running"
                    ? `${runDryRun ? "Dry run" : "Running"}… ${runElapsed}s`
                    : runStatus === "success"
                      ? `${runDryRun ? "Dry run" : "Run"} completed in ${runElapsed}s`
                      : `${runDryRun ? "Dry run" : "Run"} failed after ${runElapsed}s`}
                </span>
                {runStatus !== "running" && (
                  <button onClick={() => { setRunStatus("idle"); setLiveSteps([]); setRunError(null); setExpandedStep(null); }} className="text-[10px] text-[#555] hover:text-[#888] transition-colors">Dismiss</button>
                )}
              </div>
            )}
            {runError && <p className="text-[10px] text-rose-400 px-1">{runError}</p>}

            {/* Step list — unified: shows derived steps with live overlay, or live steps during run */}
            {(() => {
              // During/after a run with live steps, show those
              const showLive = liveSteps.length > 0;
              // Otherwise show derived steps from the API
              const showDerived = !showLive && jig.steps.length > 0;

              if (showLive) return (
                <div className="rounded-lg border border-[#1f1f23] bg-[#111113]">
                  {liveSteps.map((s, i) => (
                    <div key={i} className={`${i < liveSteps.length - 1 ? "border-b border-dashed border-[#1a1a1d]" : ""}`}>
                      <button
                        onClick={() => setExpandedStep(expandedStep === i ? null : i)}
                        className="group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-[#151517]"
                      >
                        {/* Status indicator */}
                        {s.status === "running" ? (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center mt-0.5"><span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" /></span>
                        ) : s.status === "success" || s.status === "healed" ? (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center mt-0.5"><span className="h-2 w-2 rounded-full bg-emerald-400" /></span>
                        ) : s.status === "fail" ? (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center mt-0.5"><span className="h-2 w-2 rounded-full bg-rose-400" /></span>
                        ) : (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1d] text-[10px] font-mono text-[#444] mt-0.5">{i + 1}</span>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium text-[#ddd]">{s.label}</p>
                        </div>
                        <span className="text-[10px] font-mono text-[#444] shrink-0 mt-0.5">{s.time}</span>
                        {s.output && <span className={`text-[9px] text-[#333] transition-transform duration-150 shrink-0 mt-1 ${expandedStep === i ? "rotate-90" : ""}`}>&#9656;</span>}
                      </button>
                      {expandedStep === i && s.output && (
                        <div className="px-4 pb-3 pl-12">
                          <pre className="text-[10px] text-[#888] font-mono whitespace-pre-wrap bg-[#0a0a0b] rounded-md p-2 border border-[#1f1f23] max-h-[200px] overflow-y-auto">{s.output}</pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              );

              if (showDerived) return <StepList steps={jig.steps} />;

              // No steps at all
              if (runStatus === "running") return (
                <div className="rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-6 text-center">
                  <p className="text-[11px] text-[#555] italic">Executing jig — gathering data from connected services…</p>
                </div>
              );

              return (
                <div className="rounded-lg border border-dashed border-[#1f1f23] px-4 py-6 text-center">
                  <p className="text-[11px] text-[#555]">No steps derived yet.</p>
                  {jig.stale && (
                    <button
                      onClick={async () => {
                        await fetch(`/api/jigs/${encodeURIComponent(jig.id)}/recompile`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ entity: selectedEntity ?? undefined }),
                        });
                        window.location.reload();
                      }}
                      className="mt-2 text-[10px] text-blue-400 hover:text-blue-300 transition-colors font-medium"
                    >
                      Derive steps
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        ) : (
          <div key="code" className="rounded-lg border border-[#1f1f23] bg-[#111113] p-4 font-mono overflow-x-auto flip-enter">
            <HighlightedCode code={jig.code} />
          </div>
        )}

        {/* Trigger + Run/Dry Run */}
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
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setEditingTrigger(true); setTriggerValue(jig.settings.trigger); }}
                className="group inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-left"
              >
                <span className="text-[12px] font-mono text-[#ccc] decoration-dotted underline-offset-4 group-hover:underline group-hover:decoration-[#555]">{jig.settings.trigger || "No trigger"}</span>
                <span className="text-[10px] text-[#333] opacity-0 group-hover:opacity-100 transition-opacity duration-150">&#9998;</span>
              </button>
              <span className="flex-1" />
              <button
                onClick={() => startRun(false)}
                disabled={runStatus === "running"}
                className="shrink-0 rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-medium text-white transition-all duration-150 hover:bg-emerald-500 active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {runStatus === "running" ? "Running\u2026" : "\u25B6 Run"}
              </button>
              <button
                onClick={() => startRun(true)}
                disabled={runStatus === "running"}
                className="shrink-0 rounded-md border border-emerald-600/30 bg-emerald-600/10 px-2 py-1 text-[10px] font-medium text-emerald-400 transition-all duration-150 hover:bg-emerald-600/20 active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title="Read-only — no writes"
              >
                Dry Run
              </button>
            </div>
          )}
        </div>

        {/* Runs */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider">Runs</h3>
            <div className="flex items-center gap-0.5 rounded-md border border-[#1f1f23] bg-[#0e0e10] p-0.5">
              {(() => {
                const runDates = [...new Set(jig.runs.map(r => r.date.replace("Mar ", "3/").replace("Feb ", "2/")))];
                return [{ key: null as string | null, label: "All" }, ...runDates.map(d => ({ key: d, label: d.split("/")[1] }))];
              })().map(d => (
                <button
                  key={d.label}
                  onClick={() => { setSelectedDay(d.key); setExpandedRun(null); }}
                  className={`px-1.5 py-0.5 text-[9px] rounded transition-colors cursor-pointer tabular-nums ${selectedDay === d.key ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#444] hover:text-[#888]"}`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-[#1f1f23] bg-[#111113] divide-y divide-[#1a1a1d] max-h-[300px] overflow-y-auto">
            {(selectedDay ? jig.runs.filter(r => r.date.replace("Mar ", "3/").replace("Feb ", "2/") === selectedDay) : jig.runs.slice(0, 5)).map((run, i) => (
              <div key={i}>
                <button
                  onClick={() => setExpandedRun(expandedRun === i ? null : i)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-[#151517] cursor-pointer"
                >
                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${run.status === "success" ? "bg-emerald-400" : "bg-rose-400"}`} />
                  <span className="text-[10px] text-[#666] w-11 shrink-0 tabular-nums">{run.date.replace("Mar ", "3/")}</span>
                  <span className="text-[10px] font-mono text-[#444] shrink-0">{run.duration}</span>
                  <span className="flex-1" />
                  <span className="text-[10px] font-mono text-[#444] shrink-0">{run.cost}</span>
                  <span className={`text-[9px] text-[#333] transition-transform duration-150 shrink-0 ${expandedRun === i ? "rotate-90" : ""}`}>&#9656;</span>
                </button>
                {expandedRun === i && run.steps && (
                  <div className="border-t border-[#1a1a1d]" style={{ animation: "fade-up 0.15s ease" }}>
                    {run.steps.map((s, si) => (
                      <details key={si} className="group/rs border-b border-[#1a1a1d] last:border-0">
                        <summary className="flex items-center gap-2 text-[10px] px-3 py-1.5 cursor-pointer list-none hover:bg-[#0e0e10] transition-colors">
                          <span className={`shrink-0 ${s.healed ? "text-amber-400" : "text-emerald-400/60"}`}>{s.healed ? "\u26A1" : "\u2713"}</span>
                          <span className="text-[#888] flex-1 truncate">{s.label}</span>
                          <span className="font-mono text-[#444] shrink-0">{s.time}</span>
                          {s.cost && <span className="font-mono text-amber-400/40 shrink-0">{s.cost}</span>}
                          {s.tag && <span className="rounded-full bg-violet-500/10 px-1 py-0 text-[8px] text-violet-400 shrink-0">{s.tag}</span>}
                          <span className="text-[8px] text-[#333] group-open/rs:rotate-90 transition-transform duration-150 shrink-0">{"\u25B8"}</span>
                        </summary>
                        <div className="px-3 pb-2 pt-0.5 ml-5">
                          <div className="rounded-md bg-[#0a0a0b] border border-[#1f1f23] px-3 py-2">
                            <p className="text-[9px] text-[#555] uppercase tracking-wider mb-1">Output</p>
                            <p className="text-[10px] text-[#888] font-mono whitespace-pre-wrap max-h-20 overflow-y-auto">{s.output || "Completed"}</p>
                          </div>
                        </div>
                      </details>
                    ))}
                    <div className="flex items-center justify-between px-3 py-1.5 text-[10px] text-[#444] bg-[#0e0e10]/50">
                      <span>Total: {run.duration}</span>
                      <span>Cost: {run.cost}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
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

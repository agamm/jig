"use client";

import { useState, useMemo, useEffect } from "react";
import type { Jig } from "@/types/jig";
import { ConnectionTag } from "@/components/connection-tag";
import { HighlightedCode } from "@/components/highlighted-code";
import { RunSteps, type RunStep } from "@/components/run-steps";
import { useJigRun } from "@/hooks/use-jig-run";
import { useAgent } from "@/hooks/use-agent";
import { AgentActivity } from "@/components/agent-activity";
import { TRIGGER_SUGGESTIONS } from "@/mock/mock-data";
import { useTriggerSave } from "@/hooks/use-trigger-save";
import { Spinner } from "@/components/spinner";
import { useElapsed } from "@/hooks/use-elapsed";

const statusDot = (s: string) =>
  s === "healthy" ? "bg-emerald-400" : s === "attention" ? "bg-amber-400" : "bg-rose-400";

export function JigDetailPane({ jig, selectedEntity, onClose, expanded = false, onToggleExpand, onRefresh, onConnectionClick }: {
  jig: Jig;
  selectedEntity: string | null;
  onClose: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onRefresh?: () => Promise<void> | void;
  onConnectionClick?: (name: string) => void;
}) {
  const [detailTab, setDetailTab] = useState<"steps" | "code">("steps");
  const trigger = useTriggerSave(jig.id, jig.settings.trigger);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [agentInput, setAgentInput] = useState("");

  const { mode, liveSteps, completedTools, activeTools, toolReadOnly, startRun, dismiss, cancelRun, isRunning } = useJigRun(jig.id, selectedEntity);

  const agent = useAgent(async () => {
    // Update parent state (code, trigger, connections, runs)
    onRefresh?.();
    // Derive fresh steps directly (step cache was cleared by write_jig_file)
    setDerivingSteps(true);
    try {
      const res = await fetch(`/api/jigs/${encodeURIComponent(jig.id)}/steps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: selectedEntity ?? undefined }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.steps?.length) {
          setDerivedSteps(data.steps.map((s: any) => ({ num: s.num, name: s.name, connections: s.connections })));
        }
      }
    } catch {}
    setDerivingSteps(false);
  });

  const handleAgentSend = () => {
    if (!agentInput.trim() || agent.isActive) return;
    if (agent.sessionId && (agent.status === "done" || agent.status === "error")) {
      agent.sendMessage(agentInput.trim());
    } else {
      agent.startSession(agentInput.trim(), jig.id, selectedEntity ?? undefined);
    }
    setAgentInput("");
  };
  const hasParams = jig.params && Object.keys(jig.params).length > 0;
  const [paramValues, setParamValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(jig.params ?? {}).map(([k, v]) => [k, ""]))
  );

  // Fetch derived steps — always from /steps endpoint (cached server-side by code hash)
  const [derivedSteps, setDerivedSteps] = useState<RunStep[]>(
    jig.steps.map(s => ({ num: s.num, name: s.name, connections: s.connections }))
  );
  const [derivingSteps, setDerivingSteps] = useState(false);
  const derivingElapsed = useElapsed(derivingSteps);
  useEffect(() => {
    // Use pre-loaded steps as initial value while fetching fresh ones
    if (jig.steps.length > 0) {
      setDerivedSteps(jig.steps.map(s => ({ num: s.num, name: s.name, connections: s.connections })));
    }
    let cancelled = false;
    setDerivingSteps(true);
    fetch(`/api/jigs/${encodeURIComponent(jig.id)}/steps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity: selectedEntity ?? undefined }),
    })
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data.steps?.length) {
          setDerivedSteps(data.steps.map((s: any) => ({ num: s.num, name: s.name, connections: s.connections })));
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setDerivingSteps(false); });
    return () => { cancelled = true; };
  }, [jig.id, selectedEntity]);

  // Steps: live steps during/after run, derived steps when idle
  const runSteps: RunStep[] = useMemo(() => {
    if (mode.type === "running" || mode.type === "done") return liveSteps;
    return derivedSteps;
  }, [derivedSteps, mode, liveSteps]);

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
                  disabled={derivingSteps}
                  className="rounded-md bg-emerald-600 px-2.5 py-1 text-[10px] font-medium text-white transition-all duration-150 hover:bg-emerald-500 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-emerald-600"
                >
                  &#9654; Run
                </button>
                <button
                  onClick={() => handleRun(true)}
                  disabled={derivingSteps}
                  className="rounded-md border border-emerald-600/30 bg-emerald-600/10 px-2.5 py-1 text-[10px] font-medium text-emerald-400 transition-all duration-150 hover:bg-emerald-600/20 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-emerald-600/10"
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
            {derivingSteps && runSteps.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8">
                <Spinner size={14} />
                <span className="text-[11px] text-[#666]">Analyzing steps… {derivingElapsed}s</span>
              </div>
            ) : (
              <RunSteps
                steps={runSteps}
                mode={mode}
                onClear={dismiss}
                completedTools={completedTools}
                activeTools={activeTools}
                toolReadOnly={toolReadOnly}
              />
            )}
          </div>
        ) : (
          <div key="code" className="rounded-lg border border-[#1f1f23] bg-[#111113] p-4 font-mono overflow-x-auto flip-enter">
            <HighlightedCode code={jig.code} connections={jig.settings.connections} />
          </div>
        )}

        {/* Trigger */}
        <div>
          <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Trigger</h3>
          {trigger.editing ? (
            <div className="rounded-lg border border-blue-500/30 bg-[#111113] p-3 space-y-2" style={{ animation: "fade-up 0.15s ease" }}>
              <input
                type="text"
                value={trigger.value}
                onChange={(e) => trigger.setValue(e.target.value)}
                className="w-full rounded-md border border-[#1f1f23] bg-[#0a0a0b] px-3 py-1.5 text-[12px] text-[#ededed] outline-none focus:border-blue-500/50 transition-colors duration-150"
                autoFocus
              />
              <p className="text-[10px] text-[#555]">Type naturally, e.g. &quot;every friday at 9am&quot;</p>
              <div className="flex flex-wrap gap-1.5">
                {TRIGGER_SUGGESTIONS.map(s => (
                  <button key={s} onClick={() => trigger.setValue(s)} className="rounded-md border border-[#1f1f23] bg-[#0a0a0b] px-2 py-1 text-[10px] text-[#888] transition-colors duration-150 hover:border-[#2a2a2e] hover:text-[#ededed]">
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5 pt-1">
                <button
                  disabled={trigger.saving}
                  onClick={trigger.save}
                  className="rounded-md bg-blue-600 px-2.5 py-1 text-[10px] font-medium text-white transition-colors duration-150 hover:bg-blue-500 disabled:opacity-50"
                >{trigger.saving ? "Saving…" : "Save"}</button>
                <button onClick={trigger.cancel} className="rounded-md border border-[#1f1f23] px-2.5 py-1 text-[10px] text-[#555] transition-colors duration-150 hover:text-[#888]">Cancel</button>
              </div>
            </div>
          ) : (
            <button
              onClick={trigger.startEditing}
              className="inline-flex items-center gap-2 rounded-lg border border-[#2a2a2e] bg-[#1a1a1d] px-3 py-2 text-left transition-all duration-150 hover:border-[#3a3a3e] hover:bg-[#222]"
            >
              <span className="text-[12px] font-mono text-[#ccc]">{trigger.display || "No trigger"}</span>
              <span className="text-[10px] text-[#444]">&#9998; edit</span>
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
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-[#151517]"
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
                    <div className="border-t border-[#1a1a1d] px-4 py-2.5" style={{ animation: "fade-up 0.15s ease" }}>
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
          <div className="flex flex-wrap gap-2">
            {jig.settings.connections.map(c => (
              <ConnectionTag key={c} name={c} onClick={onConnectionClick} />
            ))}
          </div>
        </div>
      </div>

      {/* Agent activity stream (shown when active) */}
      {agent.status !== "idle" && (
        <div className="border-t border-[#1f1f23] px-4 py-3 max-h-[200px] overflow-y-auto" style={{ animation: "fade-up 0.15s ease" }}>
          <div className="mb-2">
            <span className="text-[10px] font-medium text-[#555] uppercase tracking-wider">Agent</span>
          </div>
          <AgentActivity events={agent.events} status={agent.status} />
        </div>
      )}

      {/* Agent input bar */}
      <div className="border-t border-[#1f1f23] p-3">
        <div className="flex items-center gap-2 rounded-lg border border-[#1f1f23] bg-[#111113] px-3 py-2">
          <input
            type="text"
            value={agentInput}
            onChange={(e) => setAgentInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAgentSend() }}
            placeholder={agent.sessionId ? "Follow up..." : "Describe a change..."}
            disabled={agent.isActive}
            className="flex-1 bg-transparent text-[12px] text-[#ededed] outline-none placeholder:text-[#555] disabled:opacity-50"
          />
          {(agent.status === "done" || agent.status === "error") && (
            <button onClick={agent.reset} className="rounded-md border border-[#1f1f23] px-2 py-0.5 text-[10px] text-[#555] transition-colors duration-150 hover:text-[#888] hover:border-[#2a2a2e]">Clear</button>
          )}
          <button
            onClick={handleAgentSend}
            disabled={!agentInput.trim() || agent.isActive}
            className="rounded-md bg-emerald-600 px-2 py-0.5 text-[10px] font-medium text-white transition-colors duration-150 hover:bg-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            &#8593;
          </button>
        </div>
      </div>
    </aside>
  );
}

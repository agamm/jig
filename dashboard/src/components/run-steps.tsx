"use client";

import { useState } from "react";
import { ServiceIcon } from "@/components/service-icon";

/** Step with optional live run status */
export interface RunStep {
  num: number;
  name: string;
  desc?: string;
  connections?: string[];
  tools?: string[];
  agentGroup?: string;
  status?: "pending" | "running" | "success" | "fail" | "healed";
  time?: string;
  output?: string;
}

/** Mode determines how steps are displayed */
export type RunStepsMode =
  | { type: "idle" }
  | { type: "running"; elapsed: number; dryRun: boolean }
  | { type: "done"; elapsed: number; dryRun: boolean; status: "success" | "fail"; error?: string };

/** Map tool name to a service for icon display */
const TOOL_SVC: Record<string, string> = {
  gmail: "gmail", calendar: "calendar", drive: "drive", sheets: "drive",
  list_meetings: "granola", get_meetings: "granola", query_granola: "granola",
  search_repositories: "github", list_commits: "github",
};
function toolService(tool: string): string | null {
  for (const [prefix, svc] of Object.entries(TOOL_SVC)) {
    if (tool.startsWith(prefix)) return svc;
  }
  return null;
}

export function RunSteps({
  steps, mode = { type: "idle" }, onClear, emptyAction,
  completedTools = [], activeTools = [],
}: {
  steps: RunStep[];
  mode?: RunStepsMode;
  onClear?: () => void;
  emptyAction?: React.ReactNode;
  completedTools?: string[];
  activeTools?: string[];
}) {
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  // Auto-expand output when run completes
  const modeType = mode.type;
  const [prevModeType, setPrevModeType] = useState(modeType);
  if (modeType !== prevModeType) {
    setPrevModeType(modeType);
    if (modeType === "running") setExpandedStep(null);
    if (modeType === "done") {
      const lastWithOutput = steps.findLastIndex(s => s.output);
      setExpandedStep(lastWithOutput >= 0 ? lastWithOutput : null);
    }
  }

  if (steps.length === 0 && mode.type === "running") {
    return (
      <div className="rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-6 text-center">
        <p className="text-[11px] text-[#555] italic">Executing jig — gathering data from connected services…</p>
      </div>
    );
  }

  if (steps.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[#1f1f23] px-4 py-6 text-center">
        <p className="text-[11px] text-[#555]">No steps derived yet.</p>
        {emptyAction}
      </div>
    );
  }

  const isLive = mode.type !== "idle";
  const isRunning = mode.type === "running";

  return (
    <div>
      {mode.type === "done" && (
        <div className="flex items-center gap-2 text-[10px] mb-2 px-1">
          {mode.error && <span className="text-rose-400 flex-1">{mode.error}</span>}
          {onClear && <button onClick={onClear} className="text-[#555] hover:text-[#888] transition-colors ml-auto">Clear</button>}
        </div>
      )}

      <div className="rounded-lg border border-[#1f1f23] bg-[#111113]">
        {steps.map((step, i) => {
          const group = step.agentGroup;
          const prevGroup = i > 0 ? steps[i - 1].agentGroup : undefined;
          const nextGroup = i < steps.length - 1 ? steps[i + 1].agentGroup : undefined;
          const isGrouped = !!group;
          const isGroupStart = isGrouped && group !== prevGroup;
          const isGroupEnd = isGrouped && group !== nextGroup;
          const hasOutput = !!step.output;
          const isExpanded = expandedStep === i;
          const stepRunning = step.status === "running";

          // Status indicator
          const statusEl = (() => {
            if (!isLive || !step.status || step.status === "pending") {
              return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1d] text-[10px] font-mono text-[#444] mt-0.5">{step.num}</span>;
            }
            if (stepRunning) {
              return (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center mt-0.5 relative">
                  <span className="absolute h-4 w-4 rounded-full bg-blue-400/20 animate-ping" />
                  <span className="h-2.5 w-2.5 rounded-full bg-blue-400" />
                </span>
              );
            }
            if (step.status === "success" || step.status === "healed") {
              return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-[10px] text-emerald-400 mt-0.5">&#10003;</span>;
            }
            return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-[10px] text-rose-400 mt-0.5">&#10005;</span>;
          })();

          return (
            <div
              key={i}
              className={`relative ${stepRunning ? "step-running rounded-lg" : i < steps.length - 1 ? "border-b border-dashed border-[#1a1a1d]" : ""}`}
            >
              {/* Rotating border for running step */}
              {stepRunning && (
                <>
                  <div className="absolute inset-0 overflow-hidden rounded-lg">
                    <div className="absolute inset-[-200%]" style={{ animation: "spin-light 3s linear infinite", background: "conic-gradient(transparent 240deg, rgba(96,165,250,0.3) 260deg, rgba(96,165,250,0.7) 275deg, rgba(96,165,250,1) 280deg, rgba(96,165,250,0.7) 285deg, rgba(96,165,250,0.3) 300deg, transparent 320deg)" }} />
                  </div>
                  <div className="absolute inset-[1px] rounded-[7px] bg-[#111113]" />
                </>
              )}

              {/* Agent group bar */}
              {isGrouped && !stepRunning && (
                <div
                  className="absolute left-0 w-[3px] bg-violet-500/40"
                  style={{
                    top: isGroupStart ? "12px" : 0,
                    bottom: isGroupEnd ? "12px" : 0,
                    borderRadius: isGroupStart && isGroupEnd ? "2px" : isGroupStart ? "2px 2px 0 0" : isGroupEnd ? "0 0 2px 2px" : 0,
                  }}
                />
              )}
              {isGroupStart && (
                <div className={`text-[8px] text-violet-400 font-medium tracking-wide uppercase ${stepRunning ? "relative z-10 pt-3 pl-4" : "absolute left-2 -top-2.5 bg-[#111113] px-1.5 z-10"}`}>
                  agent
                </div>
              )}

              {/* Step content */}
              <div
                onClick={hasOutput ? () => setExpandedStep(isExpanded ? null : i) : undefined}
                className={`flex items-start gap-3 px-4 py-3 transition-colors duration-150 ${!stepRunning ? "hover:bg-[#151517]" : ""} ${hasOutput ? "cursor-pointer" : ""} ${stepRunning ? "relative z-10" : ""}`}
              >
                {statusEl}
                <div className="flex-1 min-w-0">
                  <p className={`text-[13px] font-medium ${stepRunning ? "text-[#ededed]" : step.status === "success" ? "text-[#999]" : "text-[#ddd]"}`}>{step.name}</p>
                  {(step.desc || (step.connections && step.connections.length > 0)) && (
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {[...new Set(step.connections)].map(c => (
                        <span key={c} className="inline-flex items-center gap-1 rounded-full bg-[#1a1a1d] border border-[#2a2a2e] px-1.5 py-0.5">
                          <ServiceIcon name={c} size={11} />
                          <span className="text-[9px] text-[#666]">{c}</span>
                        </span>
                      ))}
                      {step.desc && <span className="text-[10px] text-[#555]">{step.desc}</span>}
                    </div>
                  )}
                  {/* Tool chain — inside the first agent step */}
                  {isGroupStart && isLive && (completedTools.length > 0 || activeTools.length > 0) && (
                    <div className="flex items-center gap-1 mt-2 flex-wrap">
                      {completedTools.map((t, ti) => {
                        const svc = toolService(t);
                        return (
                          <span key={`d-${ti}`} className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5">
                            {svc && <ServiceIcon name={svc} size={9} />}
                            <span className="text-[8px] text-emerald-400/70 font-mono">{t}</span>
                          </span>
                        );
                      })}
                      {activeTools.map((t, ti) => {
                        const svc = toolService(t);
                        return (
                          <span key={`a-${ti}`} className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5">
                            {svc && <ServiceIcon name={svc} size={9} />}
                            <span className="h-1 w-1 rounded-full bg-blue-400 animate-pulse" />
                            <span className="text-[8px] text-blue-300 font-mono">{t}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                {step.time && <span className={`text-[10px] font-mono shrink-0 mt-0.5 ${stepRunning ? "text-blue-400/60" : "text-[#444]"}`}>{step.time}</span>}
                {!step.time && stepRunning && isRunning && (
                  <span className="text-[10px] font-mono text-blue-400/60 shrink-0 mt-0.5">{mode.elapsed}s</span>
                )}
                {hasOutput && (
                  <span className={`text-[9px] text-[#333] transition-transform duration-150 shrink-0 mt-1 ${isExpanded ? "rotate-90" : ""}`}>&#9656;</span>
                )}
              </div>

              {/* Expanded output */}
              {isExpanded && step.output && (
                <div className={`px-4 pb-3 pl-12 ${stepRunning ? "relative z-10" : ""}`} style={{ animation: "fade-up 0.1s ease" }}>
                  <pre className="text-[10px] text-[#888] font-mono whitespace-pre-wrap bg-[#0a0a0b] rounded-md p-2 border border-[#1f1f23] max-h-[200px] overflow-y-auto">{step.output}</pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

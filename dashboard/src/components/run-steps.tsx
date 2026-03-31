"use client";

import { useEffect, useState } from "react";
import type { JigStepTool } from "@shared/api";
import { ServiceIcon } from "@/components/service-icon";
import { formatElapsed } from "@/lib/format";
import { Spinner } from "@/components/spinner";
import { MarkdownOutput } from "@/components/markdown-output";
import { toolKey } from "@/lib/tool-review";

/** Step with optional live run status */
export interface RunStep {
  num: number;
  name: string;
  connections?: string[];
  tools?: JigStepTool[];
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

function groupToolsByConnection(tools: JigStepTool[]) {
  const grouped = new Map<string, JigStepTool[]>();
  for (const tool of tools) {
    const existing = grouped.get(tool.connection);
    if (existing) existing.push(tool);
    else grouped.set(tool.connection, [tool]);
  }
  return [...grouped.entries()];
}

export function RunSteps({
  steps, mode = { type: "idle" }, onClear, emptyAction,
  completedTools = [], activeTools = [], toolReadOnly = {},
  onConnectionClick,
  toolDisplay = "collapsed",
  onRequestRemoveTool,
  reviewedToolKeys,
  pendingToolKeys,
  onApproveTool,
}: {
  steps: RunStep[];
  mode?: RunStepsMode;
  onClear?: () => void;
  emptyAction?: React.ReactNode;
  completedTools?: string[];
  activeTools?: string[];
  toolReadOnly?: Record<string, boolean>;
  onConnectionClick?: (name: string) => void;
  toolDisplay?: "collapsed" | "expanded";
  onRequestRemoveTool?: (tool: JigStepTool) => void;
  reviewedToolKeys?: Set<string>;
  pendingToolKeys?: Set<string>;
  onApproveTool?: (tool: JigStepTool) => void;
}) {
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  // Auto-expand output when run completes
  const modeType = mode.type;
  const [prevModeType, setPrevModeType] = useState(modeType);
  useEffect(() => {
    if (modeType === prevModeType) return;
    setPrevModeType(modeType);
    if (modeType === "running") setExpandedStep(null);
    if (modeType === "done") {
      // Auto-expand: failed step first, then last step with output
      const failedIdx = steps.findIndex(s => s.status === "fail");
      const lastWithOutput = steps.findLastIndex(s => s.output);
      setExpandedStep(failedIdx >= 0 ? failedIdx : lastWithOutput >= 0 ? lastWithOutput : null);
    }
  }, [modeType, prevModeType, steps]);

  if (steps.length === 0 && mode.type === "running") {
    return (
      <div className="flex items-center justify-center gap-3 rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-6">
        <Spinner size={16} />
        <p className="text-[11px] text-[#888] italic">Executing jig — gathering data from connected services…</p>
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
  const isDryRun = mode.type !== "idle" ? mode.dryRun : false;

  return (
    <div>
      {mode.type === "done" && onClear && (
        <div className="flex justify-end mb-1">
          <button onClick={onClear} className="text-[10px] text-[#555] hover:text-[#888] transition-colors">Clear</button>
        </div>
      )}
      <div className="rounded-lg border border-[#1f1f23] bg-[#111113]">
        {steps.map((step, i) => {
          const modeError = mode.type === "done" ? mode.error : undefined;
          const hasOutput = !!step.output || (step.status === "fail" && !!modeError);
          const isExpanded = expandedStep === i;
          const stepRunning = step.status === "running";
          const groupedTools = step.tools ? groupToolsByConnection(step.tools) : [];

          // Status indicator
          const statusEl = (() => {
            if (!isLive || !step.status || step.status === "pending") {
              return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1d] text-[10px] font-mono text-[#444] mt-0.5">{step.num}</span>;
            }
            if (stepRunning) {
              return (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center mt-0.5">
                  <Spinner size={18} />
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

              {/* Step content */}
              <div
                onClick={hasOutput ? () => setExpandedStep(isExpanded ? null : i) : undefined}
                className={`flex items-start gap-3 px-4 py-3 transition-colors duration-150 ${!stepRunning ? "hover:bg-[#151517]" : ""} ${hasOutput ? "cursor-pointer" : ""} ${stepRunning ? "relative z-10" : ""}`}
              >
                {statusEl}
                <div className="flex-1 min-w-0">
                  <p className={`text-[13px] font-medium ${stepRunning ? "text-[#ededed]" : step.status === "success" ? "text-[#999]" : "text-[#ddd]"}`}>{step.name}</p>
                  {groupedTools.length > 0 && toolDisplay === "collapsed" ? (
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {groupedTools.map(([connection, tools]) => (
                        <span key={connection} className="group/tool relative inline-flex">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onConnectionClick?.(connection);
                            }}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-[#2a2a2e] bg-[#1a1a1d] px-1.5 py-0.5 transition-colors hover:border-[#3a3a3e] hover:bg-[#202024]"
                          >
                            <ServiceIcon name={connection} size={11} />
                            <span className="text-[9px] text-[#888] font-mono">{connection}</span>
                            {tools.length > 1 && (
                              <span className="rounded-full bg-[#222327] px-1 py-[1px] text-[8px] text-[#666]">
                                {tools.length}
                              </span>
                            )}
                          </button>
                          <span className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden min-w-[180px] flex-col gap-1 rounded-md border border-[#2a2a2e] bg-[#151517] px-2 py-2 shadow-lg group-hover/tool:flex">
                            {tools.map((tool) => (
                              <span key={`${tool.connection}:${tool.name}`} className="flex items-center gap-2">
                                <span className="text-[9px] font-mono text-[#ccc]">{tool.name}</span>
                                <span className={`rounded-full px-1 py-[1px] text-[8px] ${
                                  tool.readOnly
                                    ? "bg-emerald-500/10 text-emerald-300"
                                    : "bg-amber-500/10 text-amber-300"
                                }`}>
                                  {tool.readOnly ? "read" : "write"}
                                </span>
                              </span>
                            ))}
                          </span>
                        </span>
                      ))}
                    </div>
                  ) : step.tools && step.tools.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {step.tools.map((tool) => {
                        const reviewed = reviewedToolKeys?.has(toolKey(tool)) ?? false;
                        const pending = pendingToolKeys?.has(toolKey(tool)) ?? false;
                        return (
                        <span
                          key={`${tool.connection}:${tool.name}`}
                          className={`relative inline-flex items-center gap-1.5 overflow-hidden rounded-full border px-2.5 py-1.5 ${
                            pending
                              ? "border-blue-500/30"
                              : reviewed
                              ? "border-emerald-500/30 bg-emerald-500/[0.08]"
                              : "border-[#34343a] bg-[#19191c]"
                          }`}
                        >
                          {pending && (
                            <>
                              <span className="absolute inset-0 overflow-hidden rounded-full">
                                <span
                                  className="absolute inset-[-200%]"
                                  style={{
                                    animation: "spin-light 2.4s linear infinite",
                                    background: "conic-gradient(transparent 240deg, rgba(96,165,250,0.24) 260deg, rgba(96,165,250,0.55) 275deg, rgba(96,165,250,0.95) 280deg, rgba(96,165,250,0.55) 285deg, rgba(96,165,250,0.24) 300deg, transparent 320deg)"
                                  }}
                                />
                              </span>
                              <span className="absolute inset-[1px] rounded-full bg-[#19191c]" />
                            </>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onConnectionClick?.(tool.connection);
                            }}
                            disabled={pending}
                            className="relative z-10 inline-flex cursor-pointer items-center gap-1 text-left transition-colors hover:text-[#ededed] disabled:cursor-default"
                          >
                            <ServiceIcon name={tool.connection} size={11} />
                            <span className={`text-[9px] font-mono ${pending ? "text-[#dbeafe]" : reviewed ? "text-[#e7f8ef]" : "text-[#d0d0d4]"}`}>{tool.name}</span>
                          </button>
                          <span className={`relative z-10 rounded-full px-1.5 py-[1px] text-[8px] ${
                            tool.readOnly
                              ? "bg-emerald-500/10 text-emerald-300"
                              : "bg-amber-500/10 text-amber-300"
                          }`}>
                            {tool.readOnly ? "read" : "write"}
                          </span>
                          {onApproveTool && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onApproveTool(tool);
                              }}
                              disabled={pending}
                              className={`relative z-10 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] transition-colors disabled:opacity-40 ${
                                pending
                                  ? "bg-[#232327] text-[#6d7d96]"
                                  : reviewed
                                  ? "bg-emerald-500/20 text-emerald-200"
                                  : "bg-[#232327] text-[#7ad8a5] hover:bg-emerald-500/15"
                              }`}
                              title={reviewed ? `${tool.name} reviewed` : `Approve ${tool.name}`}
                            >
                              ✓
                            </button>
                          )}
                          {onRequestRemoveTool && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onRequestRemoveTool(tool);
                              }}
                              disabled={pending}
                              className={`relative z-10 inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#232327] text-[10px] transition-colors disabled:opacity-70 ${
                                pending
                                  ? "text-blue-200"
                                  : "text-[#d1a3a8] hover:bg-rose-500/15 hover:text-rose-200"
                              }`}
                              title={`Remove ${tool.name} from this jig`}
                            >
                              {pending ? "…" : "×"}
                            </button>
                          )}
                        </span>
                      )})}
                    </div>
                  ) : step.connections && step.connections.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {[...new Set(step.connections)].map(c => (
                        <button
                          key={c}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onConnectionClick?.(c);
                          }}
                          className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-[#2a2a2e] bg-[#1a1a1d] px-1.5 py-0.5 transition-colors hover:border-[#3a3a3e] hover:bg-[#202024]"
                        >
                          <ServiceIcon name={c} size={11} />
                          <span className="text-[9px] text-[#666]">{c}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {/* Tool chain — shown on the running step */}
                  {stepRunning && isLive && (completedTools.length > 0 || activeTools.length > 0) && (
                    <div className="flex items-center gap-1 mt-2 flex-wrap">
                      {completedTools.map((t, ti) => {
                        const svc = toolService(t);
                        const isWrite = isDryRun && toolReadOnly[t] === false;
                        return (
                          <span key={`d-${ti}`} className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${isWrite ? "bg-amber-500/10 border border-amber-500/20" : "bg-emerald-500/10 border border-emerald-500/20"}`}>
                            {svc && <ServiceIcon name={svc} size={9} />}
                            {isWrite && <span className="text-[7px] text-amber-400/60 font-mono">skip</span>}
                            <span className={`text-[8px] font-mono ${isWrite ? "text-amber-400/50 line-through" : "text-emerald-400/70"}`}>{t}</span>
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
                {step.time && !(stepRunning && isRunning) && <span className={`text-[10px] font-mono shrink-0 mt-0.5 ${stepRunning ? "text-blue-400/60" : "text-[#444]"}`}>{step.time}</span>}
                {stepRunning && isRunning && (
                  <span className="text-[10px] font-mono text-blue-400/60 shrink-0 mt-0.5">{formatElapsed(mode.elapsed)}</span>
                )}
                {hasOutput && (
                  <span className={`text-[9px] text-[#333] transition-transform duration-150 shrink-0 mt-1 ${isExpanded ? "rotate-90" : ""}`}>&#9656;</span>
                )}
              </div>

              {/* Expanded output — also show mode.error on failed step */}
              {isExpanded && (step.output || (step.status === "fail" && modeError)) && (
                <div className={`px-4 pb-3 pl-12 ${stepRunning ? "relative z-10" : ""}`} style={{ animation: "fade-up 0.1s ease" }}>
                  <div className="relative group/output">
                    <div className={`rounded-md border max-h-[260px] overflow-y-auto p-3 pr-8 ${step.status === "fail" ? "bg-rose-500/5 border-rose-500/20" : "bg-[#0a0a0b] border-[#1f1f23]"}`}>
                      {step.status === "fail" ? (
                        <pre className="text-[10px] font-mono whitespace-pre-wrap text-[#ccc]">{step.output || modeError || ""}</pre>
                      ) : (
                        <MarkdownOutput markdown={step.output || modeError || ""} />
                      )}
                    </div>
                    <CopyButton text={step.output || modeError || ""} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="absolute top-1.5 right-1.5 rounded-md p-1 text-[#444] opacity-0 group-hover/output:opacity-100 hover:text-[#888] hover:bg-[#1a1a1d] transition-all duration-150"
      title="Copy output"
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
    </button>
  );
}

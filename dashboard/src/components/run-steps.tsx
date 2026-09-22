"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import type { JigStepTool } from "@shared/api";
import { classifyFailure } from "@/lib/api";
import { CopyButton } from "@/components/copy-button";
import { RotatingFrame } from "@/components/rotating-frame";
import { ServiceIcon } from "@/components/service-icon";
import { formatElapsed } from "@/lib/format";
import { Spinner } from "@/components/spinner";
import { MarkdownOutput } from "@/components/markdown-output";
import { toolKey } from "@/lib/tool-review";
import { fixJigPrompt } from "@/lib/agent-prompts";
import { describeCondition, describeTool, serviceName } from "@/lib/step-labels";
import { StepCodePeek } from "@/components/step-code-peek";

/** Step with optional live run status */
export interface RunStep {
  num: number;
  name: string;
  connections?: string[];
  tools?: JigStepTool[];
  /** skipped: the run went past this step without taking its branch. */
  status?: "pending" | "running" | "success" | "fail" | "healed" | "skipped";
  time?: string;
  output?: string;
  line?: number;
  endLine?: number;
  when?: string;
  exits?: boolean;
  stopIf?: string[];
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
/** The connection a failed step was talking to, from its tool/connection metadata. */
function stepConnection(step: { tools?: JigStepTool[]; connections?: string[] }): string | null {
  return step.tools?.[0]?.connection ?? step.connections?.[0] ?? null;
}

/**
 * Offers a one-click reconnect when a failed step's error means the connection
 * needs re-auth. The verdict is an LLM classification (cached server-side and
 * by SWR per error text) — not keyword matching — so any MCP server's phrasing
 * is understood. Renders nothing until/unless the model says re-auth is needed.
 */
function ReauthPrompt({ errorText, connection, onConnectionClick }: {
  errorText: string;
  connection: string;
  onConnectionClick: (name: string) => void;
}) {
  const { data } = useSWR(
    errorText ? ["classify-failure", errorText] : null,
    () => classifyFailure(errorText),
    { revalidateOnFocus: false, dedupingInterval: 60 * 60 * 1000 },
  );
  if (!data?.needsReauth) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-2">
      <span className="text-[11px] text-amber-200/90">This connection needs to be re-authenticated.</span>
      <button
        onClick={() => onConnectionClick(connection)}
        className="ml-auto inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20"
      >
        <ServiceIcon name={connection} size={12} />
        Reconnect {connection}
        <span aria-hidden>→</span>
      </button>
    </div>
  );
}

function toolService(tool: string): string | null {
  for (const [prefix, svc] of Object.entries(TOOL_SVC)) {
    if (tool.startsWith(prefix)) return svc;
  }
  return null;
}

function groupToolsByService(tools: JigStepTool[]) {
  const grouped = new Map<string, JigStepTool[]>();
  for (const tool of tools) {
    const { service } = describeTool(tool);
    const existing = grouped.get(service);
    if (existing) existing.push(tool);
    else grouped.set(service, [tool]);
  }
  return [...grouped.entries()];
}

function BranchIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="6" cy="5" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v12" /><path d="M18 10c0 5-12 3-12 9" />
    </svg>
  );
}

function StopIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" className={className}><rect x="5" y="5" width="14" height="14" rx="3" /></svg>
  );
}

/** "if no meetings" in words when the condition reads plainly, else the code itself. */
function ConditionText({ cond, prefix }: { cond: string; prefix: string }) {
  const words = describeCondition(cond);
  return words
    ? <span>{prefix} {words}</span>
    : <span>{prefix} <code className="font-mono normal-case tracking-normal">{cond}</code></span>;
}

const PEEK_OPEN_MS = 350;
const PEEK_CLOSE_MS = 120;

export function RunSteps({
  steps, mode = { type: "idle" }, onClear, emptyAction,
  completedTools = [], activeTools = [], toolReadOnly = {},
  onConnectionClick,
  toolDisplay = "collapsed",
  onRequestRemoveTool,
  reviewedToolKeys,
  pendingToolKeys,
  onApproveTool,
  jigId,
  source,
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
  /** Jig id, required for the fix prompt on a failed step. */
  jigId?: string;
  /** Jig source; enables the code peek on step hover. */
  source?: string;
}) {
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [peek, setPeek] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePeek = (next: { index: number; anchor: HTMLElement } | null, delay: number) => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(next), delay);
  };
  const holdPeek = () => { if (peekTimer.current) clearTimeout(peekTimer.current); };
  useEffect(() => () => { if (peekTimer.current) clearTimeout(peekTimer.current); }, []);

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
        {(() => { let mainNum = 0; return steps.map((step, i) => {
          const isBranch = !!step.when;
          if (!isBranch) mainNum++;
          const skipped = step.status === "skipped";
          const modeError = mode.type === "done" ? mode.error : undefined;
          const hasOutput = !!step.output || (step.status === "fail" && !!modeError);
          const isExpanded = expandedStep === i;
          const stepRunning = step.status === "running";
          const dryRunLimited = isDryRun && !!step.output?.includes("[dry-run]") && (step.status === "healed" || step.status === "fail");
          const groupedTools = step.tools ? groupToolsByService(step.tools) : [];
          const canPeek = !!source && !!step.line && !!step.endLine;

          // Status indicator
          const statusEl = (() => {
            if (skipped) {
              return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-[#2a2a2e] mt-0.5"><span className="h-px w-2 bg-[#3a3a40]" /></span>;
            }
            if (!isLive || !step.status || step.status === "pending") {
              return isBranch
                ? <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-amber-400/25 text-amber-300/60 mt-0.5"><BranchIcon /></span>
                : <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1d] text-[10px] font-mono text-[#444] mt-0.5">{mainNum}</span>;
            }
            if (stepRunning) {
              return (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center mt-0.5">
                  <Spinner size={18} />
                </span>
              );
            }
            if (dryRunLimited) {
              return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-[10px] text-amber-300 mt-0.5">~</span>;
            }
            if (step.status === "success" || step.status === "healed") {
              return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-[10px] text-emerald-400 mt-0.5">&#10003;</span>;
            }
            return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-[10px] text-rose-400 mt-0.5">&#10005;</span>;
          })();

          return (
            <RotatingFrame
              key={i}
              active={stepRunning}
              className={`${stepRunning ? "step-running" : i < steps.length - 1 ? "border-b border-dashed border-[#1a1a1d]" : ""}`}
              roundedClassName="rounded-lg"
              innerRoundedClassName="rounded-[7px]"
              surfaceClassName="bg-[#111113]"
            >
              <div
                onClick={hasOutput ? () => setExpandedStep(isExpanded ? null : i) : undefined}
                onMouseEnter={canPeek ? (e) => schedulePeek({ index: i, anchor: e.currentTarget }, peek ? 0 : PEEK_OPEN_MS) : undefined}
                onMouseLeave={canPeek ? () => schedulePeek(null, PEEK_CLOSE_MS) : undefined}
                className={`relative flex items-start gap-3 py-3 pr-4 transition-colors duration-150 ${isBranch ? "pl-10" : "pl-4"} ${!stepRunning ? "hover:bg-[#151517]" : ""} ${hasOutput ? "cursor-pointer" : ""} ${stepRunning ? "z-10" : ""} ${skipped ? "opacity-45" : ""}`}
              >
                {isBranch && (
                  <span aria-hidden className="pointer-events-none absolute left-[25px] top-0 h-[24px] w-[13px] rounded-bl-lg border-b border-l border-dashed border-amber-400/25" />
                )}
                {statusEl}
                <div className="flex-1 min-w-0">
                  {isBranch && (
                    <p className="mb-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-amber-300/60">
                      <ConditionText prefix="Only if" cond={step.when!} />
                    </p>
                  )}
                  <p className={`text-[13px] font-medium ${
                    stepRunning
                      ? "text-[#ededed]"
                      : dryRunLimited
                      ? "text-[#d6c29a]"
                      : step.status === "success"
                      ? "text-[#999]"
                      : isBranch
                      ? "text-[#a9a9b0]"
                      : "text-[#ddd]"
                  }`}>{step.name}</p>
                  {groupedTools.length > 0 && toolDisplay === "collapsed" ? (
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {groupedTools.map(([service, tools]) => (
                        <button
                          key={service}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onConnectionClick?.(tools[0].connection);
                          }}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[#2a2a2e] bg-[#1a1a1d] py-0.5 pl-1.5 pr-2 transition-colors hover:border-[#3a3a3e] hover:bg-[#202024]"
                          title={tools.map((tool) => `${tool.connection}.${tool.name} (${tool.readOnly ? "read" : "write"})`).join("\n")}
                        >
                          <ServiceIcon name={service} size={11} />
                          <span className="max-w-[260px] truncate text-[10px]">
                            <span className="text-[#b4b4ba]">{serviceName(service)}</span>
                            <span className="text-[#4a4a50]"> · </span>
                            <span className="text-[#85858c]">{tools.map((tool) => describeTool(tool).action).join(", ")}</span>
                          </span>
                          {tools.some((tool) => !tool.readOnly) && (
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-400/80" title="Writes" />
                          )}
                        </button>
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
                            <RotatingFrame
                              active
                              roundedClassName="rounded-full"
                              innerRoundedClassName="rounded-full"
                              surfaceClassName="bg-[#19191c]"
                              duration="2.4s"
                              gradient="conic-gradient(transparent 240deg, rgba(96,165,250,0.24) 260deg, rgba(96,165,250,0.55) 275deg, rgba(96,165,250,0.95) 280deg, rgba(96,165,250,0.55) 285deg, rgba(96,165,250,0.24) 300deg, transparent 320deg)"
                            >
                              <span />
                            </RotatingFrame>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onConnectionClick?.(tool.connection);
                            }}
                            disabled={pending}
                            className="relative z-10 inline-flex cursor-pointer items-center gap-1 text-left transition-colors hover:text-[#ededed] disabled:cursor-default"
                            title={`${tool.connection}.${tool.name}`}
                          >
                            <ServiceIcon name={describeTool(tool).service} size={11} />
                            <span className={`text-[10px] ${pending ? "text-[#dbeafe]" : reviewed ? "text-[#e7f8ef]" : "text-[#d0d0d4]"}`}>
                              {serviceName(describeTool(tool).service)} · {describeTool(tool).action}
                            </span>
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
                {skipped && <span className="shrink-0 mt-0.5 text-[10px] text-[#55555c]">skipped</span>}
                {isBranch && step.exits && !skipped && (
                  <span className="shrink-0 mt-0.5 inline-flex items-center gap-1 rounded-full border border-[#2a2a2e] px-1.5 py-0.5 text-[9px] text-[#77777e]">
                    <StopIcon /> ends run
                  </span>
                )}
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
                    <div className={`rounded-md border max-h-[260px] overflow-y-auto p-3 pr-8 ${
                      dryRunLimited
                        ? "bg-amber-500/[0.04] border-amber-500/20"
                        : step.status === "fail"
                        ? "bg-rose-500/5 border-rose-500/20"
                        : "bg-[#0a0a0b] border-[#1f1f23]"
                    }`}>
                      {dryRunLimited ? (
                        <div className="space-y-2">
                          <p className="text-[10px] uppercase tracking-wider text-amber-300/85">Dry Run Limited</p>
                          <pre className="text-[10px] font-mono whitespace-pre-wrap text-[#ccc]">{step.output || modeError || ""}</pre>
                        </div>
                      ) : step.status === "fail" ? (
                        <div className="space-y-2">
                          <pre className="text-[10px] font-mono whitespace-pre-wrap text-[#ccc]">{step.output || modeError || ""}</pre>
                          {(() => {
                            const errText = [step.output, modeError].filter(Boolean).join("\n");
                            const target = stepConnection(step);
                            return (
                              <>
                                {target && onConnectionClick && errText && (
                                  <ReauthPrompt errorText={errText} connection={target} onConnectionClick={onConnectionClick} />
                                )}
                                {jigId && errText && (
                                  <div className="flex justify-end">
                                    <CopyButton
                                      text={fixJigPrompt({ origin: window.location.origin, jigId, step: step.name, error: errText })}
                                      label="Copy fix prompt"
                                      toast="Prompt copied. Paste it into Claude Code or Codex in your paired checkout."
                                      size="xs"
                                    />
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      ) : (
                        <MarkdownOutput markdown={step.output || modeError || ""} />
                      )}
                    </div>
                    <OutputCopyButton text={step.output || modeError || ""} />
                  </div>
                </div>
              )}
              {step.stopIf?.map((cond) => (
                <div key={cond} className="flex items-center gap-2 border-t border-dashed border-[#1a1a1d] py-1.5 pl-[22px] pr-4 text-[10px] text-[#6a6a72]">
                  <span className="flex h-2.5 w-2.5 items-center justify-center text-rose-300/50"><StopIcon /></span>
                  <ConditionText prefix="Stops here if" cond={cond} />
                </div>
              ))}
            </RotatingFrame>
          );
        }); })()}
      </div>
      {peek && steps[peek.index]?.line && source && (
        <StepCodePeek
          anchor={peek.anchor}
          name={steps[peek.index].name}
          source={source}
          line={steps[peek.index].line!}
          endLine={steps[peek.index].endLine!}
          tools={steps[peek.index].tools ?? []}
          onPointerEnter={holdPeek}
          onPointerLeave={() => schedulePeek(null, PEEK_CLOSE_MS)}
        />
      )}

    </div>
  );
}

function OutputCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="absolute top-1.5 right-1.5 rounded-md p-1 text-[#444] opacity-60 hover:text-[#888] hover:bg-[#1a1a1d] group-hover/output:opacity-100 transition-all duration-150"
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

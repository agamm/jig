"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import type { JigStepToolDto } from "@shared/api";
import type { Jig } from "@/types/jig";
import { ConnectionTag } from "@/components/connection-tag";
import { HighlightedCode } from "@/components/highlighted-code";
import { RunSteps, type RunStep } from "@/components/run-steps";
import { useJigRun } from "@/hooks/use-jig-run";
import { useAgent } from "@/hooks/use-agent";
import { AgentPanel } from "@/components/agent-panel";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { toast } from "@/components/toast";
import { TRIGGER_SUGGESTIONS } from "@/mock/mock-data";
import { useTriggerSave } from "@/hooks/use-trigger-save";
import { Spinner } from "@/components/spinner";
import { MarkdownOutput } from "@/components/markdown-output";
import { useElapsed } from "@/hooks/use-elapsed";
import { useJigToolApproval } from "@/lib/jig-tool-approval";
import { formatElapsed } from "@/lib/format";
import { deleteJig, fetchJigSteps } from "@/lib/api";

const statusDot = (s: string) =>
  s === "healthy" ? "bg-emerald-400" : s === "attention" ? "bg-amber-400" : "bg-rose-400";

function toolKey(tool: JigStepToolDto) {
  return `${tool.connection}:${tool.name}:${tool.readOnly ? "ro" : "rw"}`;
}

function sameTool(a: JigStepToolDto, b: JigStepToolDto) {
  return toolKey(a) === toolKey(b);
}

function formatToolNames(tools: JigStepToolDto[]) {
  const names = tools.map((tool) => tool.name);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function buildRemovalInstruction(tools: JigStepToolDto[]) {
  if (tools.length === 0) return "";
  return `Remove ${formatToolNames(tools)} from this jig and adjust the workflow if needed.`;
}

export function JigDetailPane({ jig, onClose, expanded = false, onToggleExpand, onRefresh, onDelete, onConnectionClick }: {
  jig: Jig;
  onClose: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onRefresh?: () => Promise<void> | void;
  onDelete?: () => Promise<void> | void;
  onConnectionClick?: (name: string) => void;
}) {
  const jigId = jig.sourceId ?? jig.id;
  const entity = jig.entity ?? null;
  const [detailTab, setDetailTab] = useState<"steps" | "code">("steps");
  const trigger = useTriggerSave(jigId, jig.settings.trigger, entity);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [agentInput, setAgentInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [paramsExpanded, setParamsExpanded] = useState(false);
  const [reviewedToolKeys, setReviewedToolKeys] = useState<Set<string>>(new Set());
  const [queuedRemovalTools, setQueuedRemovalTools] = useState<JigStepToolDto[]>([]);
  const tools = jig.settings.tools ?? [];
  const toolApproval = useJigToolApproval(jigId, entity, tools);
  const previousAutoRemovalRef = useRef("");

  const { mode, liveSteps, completedTools, activeTools, toolReadOnly, startRun, dismiss, cancelRun, isRunning } = useJigRun(jigId, entity);

  const agent = useAgent(async () => {
    // Update parent state (code, trigger, connections, runs)
    await onRefresh?.();
    // Derive fresh steps directly (step cache was cleared by write_jig_file)
    setDerivingSteps(true);
    try {
      const data = await fetchJigSteps(jigId, entity);
      if (data.steps?.length) {
        setDerivedSteps(data.steps.map((s) => ({ num: s.num, name: s.name, connections: s.connections, tools: s.tools })));
      }
    } catch {}
    setDerivingSteps(false);
  });

  const handleAgentSend = () => {
    if (!agentInput.trim() || agent.isActive) return;
    if (agent.sessionId && (agent.status === "done" || agent.status === "error")) {
      agent.sendMessage(agentInput.trim());
    } else {
      agent.startSession(agentInput.trim(), jigId, entity ?? undefined);
    }
    setQueuedRemovalTools([]);
    previousAutoRemovalRef.current = "";
    setAgentInput("");
  };
  const hasParams = jig.params && Object.keys(jig.params).length > 0;
  const [paramValues, setParamValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(jig.params ?? {}).map(([k, v]) => [k, ""]))
  );

  // Fetch derived steps — always from /steps endpoint (cached server-side by code hash)
  const [derivedSteps, setDerivedSteps] = useState<RunStep[]>(
    jig.steps.map(s => ({ num: s.num, name: s.name, connections: s.connections, tools: s.tools }))
  );
  const [derivingSteps, setDerivingSteps] = useState(false);
  const derivingElapsed = useElapsed(derivingSteps);
  useEffect(() => {
    // Use pre-loaded steps as initial value while fetching fresh ones
    if (jig.steps.length > 0) {
      setDerivedSteps(jig.steps.map(s => ({ num: s.num, name: s.name, connections: s.connections, tools: s.tools })));
    }
    let cancelled = false;
    setDerivingSteps(true);
    fetchJigSteps(jigId, entity)
      .then(data => {
        if (!cancelled && data.steps?.length) {
          setDerivedSteps(data.steps.map((s) => ({ num: s.num, name: s.name, connections: s.connections, tools: s.tools })));
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setDerivingSteps(false); });
    return () => { cancelled = true; };
  }, [entity, jig.id, jig.steps, jigId]);

  // Steps: live steps during/after run (with humanized names from derived), derived when idle
  const runSteps: RunStep[] = useMemo(() => {
    if (mode.type === "running" || mode.type === "done") {
      // Merge humanized names from derivedSteps into liveSteps by step number
      return liveSteps.map(live => {
        const derived = derivedSteps.find(d => d.num === live.num);
        return derived && derived.name.length <= 60 ? { ...live, name: derived.name } : live;
      });
    }
    return derivedSteps;
  }, [derivedSteps, mode, liveSteps]);
  const reviewableToolKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const step of runSteps) {
      for (const tool of step.tools ?? []) keys.add(toolKey(tool));
    }
    if (keys.size === 0) {
      for (const tool of tools) keys.add(toolKey(tool));
    }
    return keys;
  }, [runSteps]);
  const reviewableToolCount = reviewableToolKeys.size;
  const reviewedToolCount = useMemo(
    () => [...reviewedToolKeys].filter((key) => reviewableToolKeys.has(key)).length,
    [reviewedToolKeys, reviewableToolKeys]
  );
  const removalInstruction = useMemo(() => buildRemovalInstruction(queuedRemovalTools), [queuedRemovalTools]);
  useEffect(() => {
    setReviewedToolKeys(new Set());
    setQueuedRemovalTools([]);
    previousAutoRemovalRef.current = "";
  }, [toolApproval.signature]);
  useEffect(() => {
    const previousAuto = previousAutoRemovalRef.current;
    setAgentInput((current) => {
      const trimmed = current.trim();
      if (!removalInstruction) {
        if (trimmed === previousAuto) return "";
        if (previousAuto && current.includes(previousAuto)) {
          return current.replace(previousAuto, "").replace(/\n{3,}/g, "\n\n").trim();
        }
        return current;
      }
      if (!trimmed || trimmed === previousAuto) return removalInstruction;
      if (previousAuto && current.includes(previousAuto)) {
        return current.replace(previousAuto, removalInstruction);
      }
      return `${current.trim()}\n\n${removalInstruction}`;
    });
    previousAutoRemovalRef.current = removalInstruction;
  }, [removalInstruction]);

  const handleRun = (dryRun: boolean) => {
    setDetailTab("steps");
    startRun(dryRun, hasParams ? paramValues : undefined);
  };

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteJig(jigId, entity)
      setConfirmDeleteOpen(false)
      await onDelete?.()
    } catch (error: any) {
      toast.error(error?.message ?? "Failed to delete jig")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <aside
      className={`flex shrink-0 flex-col border-l border-[#1f1f23] bg-[#0e0e10] overflow-hidden transition-all duration-200 ${expanded ? "w-full" : "w-[48%]"}`}
      style={{ animation: "slide-in-right 0.2s ease" }}
    >
      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete jig?"
        message={entity
          ? `This will remove ${jig.groupName} — ${jig.name} from the workspace.`
          : `This will remove ${jig.name} from the workspace.`}
        confirmLabel="Delete Jig"
        destructive
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => !deleting && setConfirmDeleteOpen(false)}
      />

      {/* Header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-4 gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-[#ededed] whitespace-nowrap">
            {jig.groupName ? `${jig.groupName} — ${jig.name}` : jig.name}
          </h2>
          <span className={`shrink-0 h-1.5 w-1.5 rounded-full ${statusDot(jig.status)}`} />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={deleting || isRunning}
            variant="danger"
            size="sm"
            title="Delete jig"
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
          {onToggleExpand && (
            <Button
              onClick={onToggleExpand}
              variant="subtle"
              size="sm"
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? "\u21E5" : "\u21E4"}
            </Button>
          )}
          <Button
            onClick={onClose}
            variant="subtle"
            size="sm"
          >
            &#10005;
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Steps / Code toggle + Run buttons */}
        <div className="flex items-center justify-between">
          <div className="flex gap-0.5 rounded-lg border border-[#1f1f23] bg-[#0a0a0b] p-0.5 w-fit">
            <button onClick={() => setDetailTab("steps")} className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors duration-150 ${detailTab === "steps" ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`}>Steps</button>
            <button onClick={() => setDetailTab("code")} className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors duration-150 ${detailTab === "code" ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`}>Code</button>
          </div>
          <div className="flex items-center gap-1.5">
            {isRunning ? (
              <Button
                onClick={cancelRun}
                variant="danger"
                size="xs"
              >
                Cancel
              </Button>
            ) : (
              <>
                <Button
                  onClick={() => handleRun(false)}
                  disabled={derivingSteps || toolApproval.reviewRequired}
                  variant="success"
                  size="xs"
                  title={toolApproval.reviewRequired ? "Approve the tool usage below first" : undefined}
                >
                  &#9654; Run
                </Button>
                <Button
                  onClick={() => handleRun(true)}
                  disabled={derivingSteps || toolApproval.reviewRequired}
                  variant="successOutline"
                  size="xs"
                  title={toolApproval.reviewRequired ? "Approve the tool usage below first" : "Read-only — no writes"}
                >
                  Dry Run
                </Button>
              </>
            )}
          </div>
        </div>

        <div className={hasParams && !paramsExpanded ? "grid gap-2 md:grid-cols-2" : "space-y-2"}>
          {/* Model selector (disabled — coming soon) */}
          <div className="flex items-center justify-between rounded-lg border border-[#17171a] bg-[#0d0d0f] px-3 py-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[10px] font-medium uppercase tracking-wider text-[#3f3f45]">Model</span>
              <span className="text-[10px] text-[#5a5a61] font-mono truncate">claude-haiku-4.5</span>
              <span className="text-[10px] text-[#323238] shrink-0">default</span>
            </div>
            <span
              className="text-[10px] text-[#4b4b51] shrink-0"
              title="Per-jig model override coming soon"
            >
              Locked
            </span>
          </div>

          {/* Parameter inputs */}
          {hasParams && (
            <div className="rounded-lg border border-[#17171a] bg-[#0d0d0f]">
              <button
                type="button"
                onClick={() => setParamsExpanded((value) => !value)}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left"
              >
                <div className="flex items-center gap-2">
                  <h3 className="text-[10px] font-medium uppercase tracking-wider text-[#3f3f45]">Parameters</h3>
                  <span className="text-[10px] text-[#323238]">{Object.keys(jig.params!).length}</span>
                </div>
                <span className="text-[10px] text-[#4b4b51]">{paramsExpanded ? "Hide" : "Show"}</span>
              </button>
              {paramsExpanded && (
                <div className="border-t border-[#17171a] px-3 pb-3 pt-2 space-y-1.5">
                  {Object.entries(jig.params!).map(([key, hint]) => (
                    <div key={key} className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
                      <label className="text-[10px] text-[#4f4f55] font-mono truncate" title={key}>{key}</label>
                      <input
                        type="text"
                        value={paramValues[key] ?? ""}
                        onChange={(e) => setParamValues(prev => ({ ...prev, [key]: e.target.value }))}
                        placeholder={hint || key}
                        className="h-7 rounded-md border border-[#151518] bg-[#0a0a0b] px-2 text-[10px] text-[#acacb1] placeholder:text-[#36363b] outline-none focus:border-[#222228] transition-colors"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Steps or Code */}
        {detailTab === "steps" ? (
          <div key="steps" className="flip-enter">
            {derivingSteps && runSteps.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8">
                <Spinner size={14} />
                <span className="text-[11px] text-[#666]">Analyzing steps… {formatElapsed(derivingElapsed)}</span>
              </div>
            ) : (
              <RunSteps
                steps={runSteps}
                mode={mode}
                onClear={dismiss}
                completedTools={completedTools}
                activeTools={activeTools}
                toolReadOnly={toolReadOnly}
                onConnectionClick={onConnectionClick}
                toolDisplay={toolApproval.reviewRequired ? "expanded" : "collapsed"}
                reviewedToolKeys={reviewedToolKeys}
                onApproveTool={toolApproval.reviewRequired ? (tool) => {
                  setReviewedToolKeys((current) => new Set(current).add(toolKey(tool)));
                  setQueuedRemovalTools((current) => current.filter((candidate) => !sameTool(candidate, tool)));
                } : undefined}
                onRequestRemoveTool={toolApproval.reviewRequired ? (tool) => {
                  setReviewedToolKeys((current) => {
                    const next = new Set(current);
                    next.delete(toolKey(tool));
                    return next;
                  });
                  setQueuedRemovalTools((current) => (
                    current.some((candidate) => sameTool(candidate, tool)) ? current : [...current, tool]
                  ));
                } : undefined}
              />
            )}
            {toolApproval.reviewRequired && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-amber-300">Tool review required</p>
                  <p className="mt-0.5 text-[10px] text-amber-100/60">
                    Review the expanded tools in each step. Use ✓ to accept a tool and × to flag it for removal.
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[10px] text-amber-100/60">
                    {reviewableToolCount > 0 ? `${reviewedToolCount}/${reviewableToolCount} reviewed` : `${tools.length} tools`}
                  </span>
                <Button
                  onClick={toolApproval.approve}
                  disabled={reviewableToolCount > 0 && reviewedToolCount < reviewableToolCount}
                  variant="success"
                  size="xs"
                >
                  Approve Tools
                </Button>
                </div>
              </div>
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
                <Button
                  disabled={trigger.saving}
                  onClick={trigger.save}
                  variant="accent"
                  size="xs"
                >{trigger.saving ? "Saving…" : "Save"}</Button>
                <Button onClick={trigger.cancel} variant="subtle" size="xs">Cancel</Button>
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
                        <div className="max-h-48 overflow-y-auto rounded-md border border-[#1f1f23] bg-[#0a0a0b] p-3">
                          <MarkdownOutput markdown={resultStep.output} />
                        </div>
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
      <AgentPanel events={agent.events} status={agent.status} />

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
            <Button onClick={agent.reset} variant="subtle" size="xs">Clear</Button>
          )}
          <Button
            onClick={handleAgentSend}
            disabled={!agentInput.trim() || agent.isActive}
            variant="success"
            size="xs"
          >
            &#8593;
          </Button>
        </div>
      </div>
    </aside>
  );
}

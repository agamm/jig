"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import type { JigStepTool, ScheduleInfo } from "@shared/api";
import type { Jig } from "@/types/jig";
import { ConnectionTag } from "@/components/connection-tag";
import { HighlightedCode } from "@/components/highlighted-code";
import { RunSteps, type RunStep } from "@/components/run-steps";
import { useJigRun } from "@/hooks/use-jig-run";
import { useAgent } from "@/hooks/use-agent";
import { AgentInput } from "@/components/agent-input";
import { AgentPanel } from "@/components/agent-panel";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TextArea } from "@/components/input";
import { JigToolList } from "@/components/jig-tool-list";
import { JigVersions } from "@/components/jig-versions";
import { toast } from "@/components/toast";
import { TRIGGER_SUGGESTIONS } from "@/mock/mock-data";
import { useTriggerSave } from "@/hooks/use-trigger-save";
import { MarkdownOutput } from "@/components/markdown-output";
import { useElapsed } from "@/hooks/use-elapsed";
import { useJigToolApproval } from "@/lib/jig-tool-approval";
import { formatElapsed } from "@/lib/format";
import { deleteJig, fetchOpenRouterCatalog, updateJigModel, updateJigTimeouts, updateSchedule } from "@/lib/api";
import { useJigSteps, useConnections, useModels, usePending } from "@/lib/swr";
import type { OpenRouterModelInfo } from "@shared/api";
import { PendingChangesBanner } from "@/components/pending-changes-banner";
import { ServiceIcon } from "@/components/service-icon";
import { PaneHeader } from "@/components/pane-header";
import { PaneSection } from "@/components/pane-section";
import { SegmentedControl } from "@/components/segmented-control";
import { LoadingState, Notice } from "@/components/state-panel";
import { TriggerEditor } from "@/components/trigger-editor";
import { buildRemovalInstruction, getReviewableToolKeys, sameTool, toolKey } from "@/lib/tool-review";

const statusDot = (s: string) =>
  s === "healthy" ? "bg-emerald-400" : s === "attention" ? "bg-amber-400" : "bg-rose-400";

function formatScheduleTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const isToday = now.toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  if (isToday) return `Today ${time}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ` ${time}`;
}

function ScheduleSection({ schedule, jigId, onRefresh }: { schedule: ScheduleInfo; jigId: string; onRefresh?: () => Promise<void> | void }) {
  const [toggling, setToggling] = useState(false);

  const handleToggle = async () => {
    setToggling(true);
    try {
      await updateSchedule(jigId, { enabled: !schedule.enabled });
      await onRefresh?.();
    } catch {
      toast.error("Failed to update schedule");
    }
    setToggling(false);
  };

  return (
    <PaneSection title="Schedule">
      <div className="rounded-lg border border-[#1f1f23] bg-[#111113] divide-y divide-[#1a1a1d]">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${schedule.error ? "bg-rose-400" : schedule.enabled ? "bg-emerald-400" : "bg-[#333]"}`} />
            <span className="text-[11px] text-[#ccc]">
              {schedule.error ? "Error" : schedule.enabled ? "Active" : "Paused"}
            </span>
          </div>
          <button
            onClick={handleToggle}
            disabled={toggling}
            className="text-[10px] text-[#666] hover:text-[#ededed] transition-colors disabled:opacity-50"
          >
            {toggling ? "…" : schedule.enabled ? "Pause" : "Resume"}
          </button>
        </div>
        {schedule.error && (
          <div className="px-3 py-2 text-[11px] text-rose-300 bg-rose-950/20 border-y border-rose-950/30">
            {schedule.error}
          </div>
        )}
        <div className="grid grid-cols-2 gap-px">
          <div className="px-3 py-2">
            <p className="text-[9px] text-[#444] uppercase tracking-wider">Next Run</p>
            <p className="text-[11px] text-[#ccc] mt-0.5">{formatScheduleTime(schedule.nextRunAt)}</p>
          </div>
          <div className="px-3 py-2">
            <p className="text-[9px] text-[#444] uppercase tracking-wider">Last Run</p>
            <p className="text-[11px] text-[#ccc] mt-0.5">{formatScheduleTime(schedule.lastRunAt)}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-[#444] uppercase tracking-wider">Type</span>
            <span className="text-[10px] font-mono text-[#888]">{schedule.triggerType}</span>
          </div>
          {schedule.triggerType === "cron" && (
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-[#444] uppercase tracking-wider">If Missed</span>
              <span className="text-[10px] font-mono text-[#888]">{schedule.missedStrategy}</span>
            </div>
          )}
          {schedule.triggerType === "cron" && schedule.timezone && (
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-[#444] uppercase tracking-wider">TZ</span>
              <span className="text-[10px] font-mono text-[#888]">{schedule.timezone}</span>
            </div>
          )}
        </div>
        {schedule.triggerType === "webhook" && schedule.webhookUrl && (
          <WebhookUrlRow url={schedule.webhookUrl} />
        )}
      </div>
    </PaneSection>
  );
}

function WebhookUrlRow({ url }: { url: string }) {
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [copied, setCopied] = useState<"url" | "curl" | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testBody, setTestBody] = useState(
    '{\n  "message": {\n    "text": "hello from test",\n    "chat": { "id": "12345" },\n    "from": { "first_name": "Test" }\n  }\n}'
  );
  const [testing, setTesting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!copyMenuOpen) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setCopyMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [copyMenuOpen]);

  function buildCurl(): string {
    const safeBody = testBody.trim() || "{}";
    // Single-quoted heredoc-free curl, portable across shells
    return `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${safeBody.replace(/'/g, "'\\''")}'`;
  }

  async function copyTo(kind: "url" | "curl") {
    try {
      const text = kind === "url" ? url : buildCurl();
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setCopyMenuOpen(false);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("Failed to copy");
    }
  }

  async function sendTest() {
    let parsed: any;
    try {
      parsed = JSON.parse(testBody || "{}");
    } catch (e: any) {
      toast.error(`Invalid JSON: ${e?.message ?? "parse error"}`);
      return;
    }
    setTesting(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (res.ok) {
        toast.success(`POST ${res.status} — jig triggered`);
      } else {
        const text = await res.text().catch(() => "");
        toast.error(`POST ${res.status}: ${text || res.statusText}`);
      }
    } catch (e: any) {
      toast.error(`Request failed: ${e?.message ?? e}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="border-t border-[#1f1f23] px-3 py-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[9px] text-[#444] uppercase tracking-wider">Webhook URL</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTestOpen((o) => !o)}
            className="text-[9px] text-[#666] hover:text-emerald-400 transition-colors"
            type="button"
          >
            {testOpen ? "hide test" : "test"}
          </button>
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setCopyMenuOpen((o) => !o)}
              className="text-[9px] text-[#666] hover:text-emerald-400 transition-colors"
              type="button"
            >
              {copied ? `copied ${copied}` : "copy ▾"}
            </button>
            {copyMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-10 min-w-[120px] rounded-md border border-[#2a2a2e] bg-[#141416] shadow-lg">
                <button
                  onClick={() => copyTo("url")}
                  className="block w-full text-left px-3 py-1.5 text-[10px] text-[#ccc] hover:bg-[#1a1a1d] transition-colors"
                  type="button"
                >
                  Copy URL
                </button>
                <button
                  onClick={() => copyTo("curl")}
                  className="block w-full text-left px-3 py-1.5 text-[10px] text-[#ccc] hover:bg-[#1a1a1d] transition-colors border-t border-[#2a2a2e]"
                  type="button"
                >
                  Copy as curl
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <code
        className="block text-[9px] font-mono text-[#888] break-all cursor-pointer hover:text-[#ccc]"
        onClick={() => copyTo("url")}
        title="Click to copy"
      >
        {url}
      </code>
      {testOpen && (
        <div className="mt-2 space-y-1.5">
          <label className="block text-[9px] text-[#444] uppercase tracking-wider">Test POST body (JSON)</label>
          <TextArea
            value={testBody}
            onChange={(e) => setTestBody(e.target.value)}
            className="h-32 resize-y font-mono text-[10px]"
            spellCheck={false}
          />
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={sendTest}
              disabled={testing}
              className="rounded bg-emerald-500/10 border border-emerald-500/30 px-2 py-1 text-[10px] text-emerald-300 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
              type="button"
            >
              {testing ? "Sending…" : "Send POST"}
            </button>
          </div>
        </div>
      )}
      <p className="text-[9px] text-[#444] mt-1">
        POST to this URL to trigger the jig. Include <code className="text-[#666]">?token=...</code>.
      </p>
    </div>
  );
}

export function JigDetailPane({ jig, onClose, onRefresh, onDelete, onConnectionClick }: {
  jig: Jig;
  onClose: () => void;
  onRefresh?: () => Promise<void> | void;
  onDelete?: (jigId: string) => Promise<void> | void;
  onConnectionClick?: (name: string) => void;
}) {
  const jigId = jig.id;
  const [detailTab, setDetailTab] = useState<"steps" | "code">("steps");
  const trigger = useTriggerSave(jigId, jig.settings.trigger);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [reviewedToolKeys, setReviewedToolKeys] = useState<Set<string>>(new Set());
  const [queuedRemovalTools, setQueuedRemovalTools] = useState<JigStepTool[]>([]);
  const tools = jig.settings.tools ?? [];
  const toolApproval = useJigToolApproval(tools, jig.settings.permissions, onRefresh);
  const previousAutoRemovalRef = useRef("");

  // Pre-run gate: if the jig imports connections that aren't currently
  // connected, ask before firing off a run — otherwise we'd silently
  // trigger an OAuth popup from the runtime's first tool call, which
  // surprises users.
  const { data: allConnections } = useConnections();
  const [missingConnections, setMissingConnections] = useState<string[] | null>(null);
  const runOptions = useMemo(() => ({
    onMissingConnections: (connections: string[]) => setMissingConnections(connections),
  }), []);
  const { mode, liveSteps, completedTools, activeTools, toolReadOnly, startRun, dismiss, cancelRun, isRunning, canCancel } = useJigRun(jigId, runOptions);
  const requiredConnections: string[] = jig.settings.connections ?? [];
  const disconnectedRequired: string[] = (() => {
    if (!allConnections) return []
    const connectedSet = new Set(allConnections.filter((c) => c.connected).map((c) => c.name))
    return requiredConnections.filter((n: string) => !connectedSet.has(n))
  })();

  // Pending changes for this jig (v12). The agent writes here; user approves
  // or discards via the banner. Revalidates on agent activity.
  const { data: pending, mutate: revalidatePending } = usePending(jigId);

  const agent = useAgent(async () => {
    await onRefresh?.();
    // Revalidate steps + pending after jig data refreshes
    await revalidateSteps();
    await revalidatePending();
  });

  // Revalidate pending when the agent finishes a write_jig_file tool call.
  // Filtering avoids a refetch on every text/thinking event (10× chattier).
  const lastWriteEvent = useMemo(() => {
    for (let i = agent.events.length - 1; i >= 0; i--) {
      const ev = agent.events[i];
      if (ev.type === "tool-call" && ev.tool === "write_jig_file" && ev.status === "done") return i;
    }
    return -1;
  }, [agent.events]);
  useEffect(() => { revalidatePending(); }, [lastWriteEvent, revalidatePending]);

  // Fetch derived steps via SWR (cached server-side by code hash)
  const { data: stepsData, isValidating: derivingSteps, error: stepsError, mutate: revalidateSteps } = useJigSteps(jigId);
  const derivedSteps: RunStep[] = useMemo(() => {
    const raw = stepsData?.steps ?? jig.steps;
    return raw.map(s => ({ num: s.num, name: s.name, connections: s.connections, tools: s.tools }));
  }, [stepsData, jig.steps]);
  const deriveError = stepsError?.message ?? (stepsData && !stepsData.steps?.length ? "Steps could not be derived from this jig yet." : null);
  const derivingElapsed = useElapsed(derivingSteps);

  // Steps: live steps during/after run (with humanized names from derived), derived when idle
  const runSteps: RunStep[] = useMemo(() => {
    if (mode.type === "running" || mode.type === "done") {
      if (liveSteps.length === 0) {
        return mode.type === "running"
          ? derivedSteps.map((step, index) => ({
            ...step,
            status: index === 0 ? "running" as const : "pending" as const,
          }))
          : derivedSteps
      }

      if (derivedSteps.length === 0) return liveSteps;

      const liveByNum = new Map(liveSteps.map((step) => [step.num, step]));
      const mergedSteps = derivedSteps.map((derived) => {
        const live = liveByNum.get(derived.num);
        if (!live) {
          return {
            ...derived,
            status: mode.type === "running" ? "pending" as const : undefined,
          };
        }

        const merged: RunStep = {
          ...derived,
          ...live,
          tools: derived.tools ?? live.tools,
          connections: derived.connections ?? live.connections,
        };
        if (derived.name.length <= 60) merged.name = derived.name;
        return merged;
      });

      const extraLiveSteps = liveSteps.filter((live) => !derivedSteps.some((derived) => derived.num === live.num));
      return [...mergedSteps, ...extraLiveSteps];
    }
    return derivedSteps;
  }, [derivedSteps, mode, liveSteps]);
  const runStartError = mode.type === "done" && mode.status === "fail" && liveSteps.length === 0
    ? mode.error ?? "Run failed before any steps started."
    : null;
  const reviewableToolKeys = useMemo(() => getReviewableToolKeys(runSteps, tools), [runSteps, tools]);
  const reviewableToolCount = reviewableToolKeys.size;
  const reviewedToolCount = useMemo(
    () => [...reviewedToolKeys].filter((key) => reviewableToolKeys.has(key)).length,
    [reviewedToolKeys, reviewableToolKeys]
  );
  const removalInstruction = useMemo(() => buildRemovalInstruction(queuedRemovalTools), [queuedRemovalTools]);
  const pendingToolKeys = useMemo(() => new Set(queuedRemovalTools.map((tool) => toolKey(tool))), [queuedRemovalTools]);
  const showDeriveFallback = detailTab === "steps" && mode.type === "idle" && !derivingSteps && runSteps.length === 0 && !!deriveError;
  // The "Approve Tools" button is always clickable when review is required —
  // clicking it approves everything at once (no need to click ✓ on each tool).
  const approvalReady = runSteps.length === 0 ? tools.length > 0 : true;

  // Approve-all wrapper: mark every reviewable tool as reviewed, then commit.
  const approveAllTools = async () => {
    setReviewedToolKeys(new Set(reviewableToolKeys));
    await toolApproval.approve();
  };
  useEffect(() => {
    setReviewedToolKeys(new Set());
    setQueuedRemovalTools([]);
    previousAutoRemovalRef.current = "";
  }, [toolApproval.signature]);
  useEffect(() => {
    previousAutoRemovalRef.current = removalInstruction;
  }, [removalInstruction]);

  const handleRun = (dryRun: boolean) => {
    if (disconnectedRequired.length > 0) {
      setMissingConnections(disconnectedRequired);
      return;
    }
    setDetailTab("steps");
    startRun(dryRun);
  };

  const dismissMissingConnectionsDialog = () => {
    setMissingConnections(null);
  };

  const openConnectionFromDialog = (name: string) => {
    setMissingConnections(null);
    onConnectionClick?.(name);
  };

  const retryDerivation = () => { revalidateSteps(); };

  const handleVersionRestored = async () => {
    // v12: restore writes to pending; user reviews + approves via the banner.
    // No tab switch needed — the pending banner is visible regardless.
    await revalidatePending()
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteJig(jigId)
      setConfirmDeleteOpen(false)
      await onDelete?.(jigId)
    } catch (error: any) {
      toast.error(error?.message ?? "Failed to delete jig")
    } finally {
      setDeleting(false)
    }
  }

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(jig.code)
      setCodeCopied(true)
      setTimeout(() => setCodeCopied(false), 1500)
    } catch {
      toast.error("Failed to copy code")
    }
  }

  return (
    <aside
      className="flex h-full w-full flex-col bg-[#0e0e10] overflow-hidden"
    >
      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete jig?"
        message={`This will remove ${jig.name} from the workspace.`}
        confirmLabel="Delete Jig"
        destructive
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => !deleting && setConfirmDeleteOpen(false)}
      />

      {missingConnections && missingConnections.length > 0 && (
        <MissingConnectionsDialog
          connections={missingConnections}
          onConnect={openConnectionFromDialog}
          onCancel={dismissMissingConnectionsDialog}
        />
      )}

      <PaneHeader
        title={jig.name}
        statusDotClass={statusDot(jig.status)}
        actions={
          <>
            <Button
              onClick={() => setConfirmDeleteOpen(true)}
              disabled={deleting || isRunning}
              variant="danger"
              size="sm"
              title="Delete jig"
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
            <Button
              onClick={onClose}
              variant="subtle"
              size="sm"
            >
              &#10005;
            </Button>
          </>
        }
      />

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Pending changes banner — visible whenever the jig has an unapproved pending version. */}
        {pending && (
          <PendingChangesBanner
            jigId={jigId}
            pending={pending}
            agentStatus={agent.status}
            onApproved={async () => {
              await revalidatePending();
              await onRefresh?.();
              await revalidateSteps();
            }}
            onDiscarded={async () => {
              await revalidatePending();
              await revalidateSteps();
            }}
          />
        )}
        {/* Steps / Code toggle + Run buttons */}
        <div className="flex items-center justify-between">
          <SegmentedControl
            value={detailTab}
            onChange={setDetailTab}
            options={[
              { value: "steps", label: "Steps" },
              { value: "code", label: "Code" },
            ]}
          />
          <div className="flex items-center gap-1.5">
            {isRunning ? (
              <Button
                onClick={cancelRun}
                disabled={!canCancel}
                variant="danger"
                size="xs"
                title={!canCancel ? "Waiting for the run to start on the server" : undefined}
              >
                {canCancel ? "Cancel" : "Starting…"}
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

        <div className="space-y-2">
          <ModelSelector jig={jig} onChange={() => onRefresh?.()} />
        </div>

        {/* Steps or Code */}
        {detailTab === "steps" ? (
          <div key="steps" className="flip-enter">
            {derivingSteps && runSteps.length === 0 ? (
              <LoadingState message={`Analyzing steps… ${formatElapsed(derivingElapsed)}`} className="py-8" />
            ) : (
              <RunSteps
                steps={runSteps}
                mode={mode}
                onClear={dismiss}
                emptyAction={showDeriveFallback ? (
                  <div className="mt-3 space-y-3 text-left">
                    <Notice
                      tone="warning"
                      title="Step derivation failed"
                      actions={
                        <>
                          <Button onClick={retryDerivation} variant="subtle" size="xs">Retry Derivation</Button>
                          <Button onClick={() => setDetailTab("code")} variant="subtle" size="xs">View Code</Button>
                        </>
                      }
                    >
                      {deriveError}
                    </Notice>
                    {tools.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-[10px] text-amber-100/55">
                          The jig still has a detected toolset. You can review that flat list and approve it even without derived steps.
                        </p>
                        <JigToolList tools={tools} />
                        {toolApproval.reviewRequired && (
                          <Notice
                            tone="warning"
                            title="Flat fallback review"
                            actions={
                              <Button onClick={approveAllTools} disabled={toolApproval.saving} variant="success" size="xs">
                                {toolApproval.saving ? "Approving…" : "Approve Tools"}
                              </Button>
                            }
                          >
                            Review and approve the detected tools so this jig can run.
                          </Notice>
                        )}
                      </div>
                    )}
                  </div>
                ) : undefined}
                completedTools={completedTools}
                activeTools={activeTools}
                toolReadOnly={toolReadOnly}
                onConnectionClick={onConnectionClick}
                toolDisplay={toolApproval.reviewRequired ? "expanded" : "collapsed"}
                reviewedToolKeys={reviewedToolKeys}
                pendingToolKeys={pendingToolKeys}
                toolsLocked={agent.isActive}
                jigId={jig.id}
                stepModelOverrides={jig.stepModelOverrides}
                jigBaseModel={jig.modelOverride ?? jig.modelInCode ?? null}
                onStepModelChange={() => {
                  // Both caches need to refresh: jig (for stepModelOverrides
                  // in the picker UI state) AND steps (for the chip relabel
                  // to land on the page without a hard reload).
                  void revalidateSteps()
                  onRefresh?.()
                }}
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
            {toolApproval.reviewRequired && runSteps.length > 0 && (
              <Notice
                tone="warning"
                title="Tool review required"
                className="mt-3"
                actions={
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-amber-100/60">
                      {reviewableToolCount > 0 ? `${reviewedToolCount}/${reviewableToolCount} reviewed` : `${tools.length} tools`}
                    </span>
                    <Button
                      onClick={approveAllTools}
                      disabled={!approvalReady || toolApproval.saving}
                      variant="success"
                      size="xs"
                    >
                      {toolApproval.saving ? "Approving…" : "Approve Tools"}
                    </Button>
                  </div>
                }
              >
                Review the expanded tools in each step. Use ✓ to accept a tool and × to flag it for removal.
              </Notice>
            )}
            {runStartError && (
              <Notice tone="danger" title="Run failed" className="mt-3">
                {runStartError}
              </Notice>
            )}
          </div>
        ) : (
          <div key="code" className="relative rounded-lg border border-[#1f1f23] bg-[#111113] p-4 font-mono overflow-x-auto flip-enter">
            <button
              type="button"
              onClick={handleCopyCode}
              className="absolute right-3 top-3 z-10 rounded-md border border-[#2a2a2e] bg-[#0d0d0f] px-2 py-1 text-[10px] text-[#888] transition-colors hover:border-[#3a3a3e] hover:text-[#ededed]"
              title="Copy code"
            >
              {codeCopied ? "Copied" : "Copy"}
            </button>
            <HighlightedCode code={jig.code} connections={jig.settings.connections} />
          </div>
        )}

        <PaneSection title="Trigger">
          <TriggerEditor trigger={trigger} suggestions={TRIGGER_SUGGESTIONS} />
        </PaneSection>

        {jig.schedule && (
          <ScheduleSection schedule={jig.schedule} jigId={jigId} onRefresh={onRefresh} />
        )}

        <PaneSection title="Timeouts">
          <TimeoutsEditor jig={jig} onChange={() => onRefresh?.()} />
        </PaneSection>

        <PaneSection
          title="Runs"
          meta={<span className="text-[10px] text-[#444]">{jig.runs.length} total</span>}
        >
          <div className="rounded-lg border border-[#1f1f23] bg-[#111113] divide-y divide-[#1a1a1d] max-h-[300px] overflow-y-auto">
            {jig.runs.slice(0, 10).map((run, i) => {
              const resultStep = [...(run.steps ?? [])].reverse().find((s) => s.output?.trim());
              const runOutput = resultStep?.output ?? run.output;
              const outputPreview = runOutput?.slice(0, 80);
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
                    <div className="border-t border-[#1a1a1d] px-4 py-2.5 space-y-2" style={{ animation: "fade-up 0.15s ease" }}>
                      {run.status === "fail" && run.error && (
                        <div className="max-h-48 overflow-y-auto rounded-md border border-rose-500/20 bg-rose-500/5 p-3">
                          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-rose-400/80 mb-1">Error</p>
                          <pre className="whitespace-pre-wrap break-words text-[10px] leading-relaxed text-rose-200/90 font-mono">{run.error}</pre>
                        </div>
                      )}
                      {runOutput ? (
                        <div className="max-h-48 overflow-y-auto rounded-md border border-[#1f1f23] bg-[#0a0a0b] p-3">
                          <MarkdownOutput markdown={runOutput} />
                        </div>
                      ) : !(run.status === "fail" && run.error) ? (
                        <p className="text-[10px] text-[#555] italic">No output recorded</p>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </PaneSection>

        <PaneSection title="History">
          <JigVersions
            jigId={jigId}
            refreshKey={jig.code}
            onRestored={handleVersionRestored}
          />
        </PaneSection>

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

        <PaneSection title="Connections">
          <div className="flex flex-wrap gap-2">
            {jig.settings.connections.map(c => (
              <ConnectionTag key={c} name={c} onClick={onConnectionClick} />
            ))}
          </div>
        </PaneSection>
      </div>

      {/* Agent activity stream (shown when active) */}
      <AgentPanel
        events={agent.events}
        status={agent.status}
        requiredConnections={agent.requiredConnections}
        suggestedConnections={agent.suggestedConnections}
        unknownConnections={agent.unknownConnections}
        metrics={agent.metrics}
        onConnectionClick={onConnectionClick}
        onRetry={() => agent.sendMessage("Continue — retry the last step.")}
      />

      {/* Agent input bar */}
      <div className="border-t border-[#1f1f23] p-3">
        <AgentInput
          agent={agent}
          jigId={jigId}
          externalValue={removalInstruction || undefined}
        />
      </div>
    </aside>
  );
}

/**
 * Pre-run gate: this jig imports connections that aren't authorized yet.
 * Gives the user an explicit connection path instead of surfacing the
 * runtime's missing generated-module error after the run has already failed.
 */
function MissingConnectionsDialog({
  connections,
  onConnect,
  onCancel,
}: {
  connections: string[];
  onConnect: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl border border-[#2a2a2e] bg-[#111113] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "fade-up 0.15s ease" }}
      >
        <div className="border-b border-[#1f1f23] px-5 py-4">
          <h3 className="text-[14px] font-semibold text-[#ededed]">
            {connections.length === 1 ? "Connection required" : "Connections required"}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-[#666]">
            This jig uses {connections.length === 1 ? "a service" : "services"} that {connections.length === 1 ? "isn't" : "aren't"} authorized yet. Connect {connections.length === 1 ? "it" : "them"} before running.
          </p>
        </div>

        <div className="px-5 py-3 space-y-1.5">
          {connections.map((name) => (
            <div
              key={name}
              className="flex items-center justify-between gap-3 rounded-lg border border-[#1f1f23] bg-[#0d0d0f] px-3 py-2.5"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <ServiceIcon name={name} size={16} />
                <span className="truncate text-[13px] text-[#ededed] capitalize">{name}</span>
                <span className="rounded-full border border-[#2a2a2e] bg-[#1a1a1d] px-1.5 py-0.5 text-[9px] text-[#888]">
                  not connected
                </span>
              </div>
              <button
                onClick={() => onConnect(name)}
                className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.08] px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/[0.14] transition-colors"
              >
                Connect
              </button>
            </div>
          ))}
        </div>

        <div className="flex justify-end border-t border-[#1f1f23] px-5 py-4">
          <button
            onClick={onCancel}
            className="rounded-md border border-[#2a2a2e] bg-[#0a0a0b] px-3 py-1.5 text-[12px] text-[#888] hover:text-[#ededed] transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model selector — per-jig override on top of the global default.
//
// Precedence (high → low): per-call > per-step > dashboard override (this
// component) > jig source `{model: ...}` > global default. Clearing the
// dropdown falls back to the next level down.
// ---------------------------------------------------------------------------

// Per-jig timeout overrides (minutes). Empty = global default (run 30m, tool 5m).
const DEFAULT_RUN_MIN = 30;
const DEFAULT_TOOL_MIN = 5;

function TimeoutsEditor({ jig, onChange }: { jig: Jig; onChange: () => void }) {
  const msToMin = (ms: number | null | undefined): string =>
    typeof ms === "number" && ms > 0 ? String(Math.round((ms / 60000) * 10) / 10) : "";
  const [runMin, setRunMin] = useState(msToMin(jig.runTimeoutMs));
  const [toolMin, setToolMin] = useState(msToMin(jig.toolTimeoutMs));
  const [saving, setSaving] = useState(false);

  // Resync when the jig prop changes (e.g. after a refresh from elsewhere).
  useEffect(() => { setRunMin(msToMin(jig.runTimeoutMs)); setToolMin(msToMin(jig.toolTimeoutMs)); }, [jig.runTimeoutMs, jig.toolTimeoutMs]);

  const dirty = runMin !== msToMin(jig.runTimeoutMs) || toolMin !== msToMin(jig.toolTimeoutMs);
  const toMs = (v: string): number | null => {
    const n = Number(v);
    return v.trim() && Number.isFinite(n) && n > 0 ? Math.round(n * 60000) : null;
  };

  async function save() {
    setSaving(true);
    try {
      await updateJigTimeouts(jig.id, { runTimeoutMs: toMs(runMin), toolTimeoutMs: toMs(toolMin) });
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save timeouts");
    } finally {
      setSaving(false);
    }
  }

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    placeholder: number,
    hint: string,
  ) => (
    <div className="flex flex-1 items-center justify-between rounded-lg border border-[#1f1f23] bg-[#0e0e10] px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[12px] text-[#ededed]">{label}</div>
        <div className="text-[10px] text-[#555]">{hint}</div>
      </div>
      <div className="flex items-baseline gap-1.5">
        <input
          type="number" min="1" inputMode="decimal"
          value={value}
          onChange={(e) => set(e.target.value)}
          placeholder={String(placeholder)}
          className="ui-num w-14 rounded-md border border-[#242428] bg-[#141416] px-2 py-1 text-right font-mono text-[13px] text-[#ededed] outline-none transition-colors focus:border-emerald-500/40"
        />
        <span className="text-[10px] text-[#555]">min</span>
      </div>
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {field("Run", runMin, setRunMin, DEFAULT_RUN_MIN, `default ${DEFAULT_RUN_MIN}m`)}
        {field("Tool", toolMin, setToolMin, DEFAULT_TOOL_MIN, `default ${DEFAULT_TOOL_MIN}m`)}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-[10px] text-[#555]">Leave empty to use the global default. Lower = fail faster; raise for long jobs.</span>
        {dirty && (
          <button
            onClick={save}
            disabled={saving}
            className="ml-auto rounded-md bg-emerald-600/90 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
    </div>
  );
}

function ModelSelector({ jig, onChange }: { jig: Jig; onChange: () => void }) {
  const { data: globalModels } = useModels();
  const [catalog, setCatalog] = useState<OpenRouterModelInfo[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  const override = jig.modelOverride ?? null;
  const codeModel = jig.modelInCode ?? null;
  const globalMain = globalModels?.main.id ?? null;
  const effective = override ?? codeModel ?? globalMain ?? "(default)";
  const source: "override" | "code" | "default" = override
    ? "override"
    : codeModel
    ? "code"
    : "default";

  // Lazy-load the catalog the first time the popover opens.
  useEffect(() => {
    if (!open || catalog) return;
    fetchOpenRouterCatalog()
      .then((res) => setCatalog(res.models))
      .catch((e) => {
        console.error("[model-selector] failed to load catalog:", e);
        setCatalog([]);
      });
  }, [open, catalog]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    const matches = q
      ? catalog.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      : catalog;
    const head = matches.slice(0, 50);
    // Always surface the active override even if it's outside the top-50
    // window — otherwise the picker hides what the user just picked.
    if (override && !head.some((m) => m.id === override)) {
      const fromCatalog = catalog.find((m) => m.id === override);
      const synthesized: OpenRouterModelInfo = fromCatalog ?? {
        id: override,
        name: override,
        description: undefined,
        contextLength: 0,
        promptPriceUsdPerM: 0,
        completionPriceUsdPerM: 0,
        blendedPriceUsdPerM: 0,
        supportsTools: false,
        supportsReasoning: false,
        supportsImages: false,
        createdAt: 0,
        rank: 0,
      };
      return [synthesized, ...head];
    }
    return head;
  }, [catalog, query, override]);

  async function applyChoice(modelId: string | null) {
    setSaving(true);
    try {
      await updateJigModel(jig.id, modelId);
      toast.success(
        modelId ? `Jig model: ${modelId.split("/").pop() ?? modelId}` : "Jig model: using default",
        { durationMs: 2000 },
      );
      onChange();
      setOpen(false);
      setQuery("");
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to update model");
    } finally {
      setSaving(false);
    }
  }

  const shortLabel = (id: string) => id.split("/").pop() ?? id;

  return (
    <div className="relative" ref={popRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-lg border border-[#17171a] bg-[#0d0d0f] px-3 py-1.5 hover:border-[#26262b] transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[#3f3f45]">Model</span>
          <span className="text-[10px] text-[#9a9aa3] font-mono truncate">{shortLabel(effective)}</span>
          <span className="text-[10px] text-[#5a5a61] shrink-0">
            {source === "override" ? "override" : source === "code" ? "from code" : "default"}
          </span>
        </div>
        <span className="text-[10px] text-[#5a5a61] shrink-0">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-lg border border-[#1f1f23] bg-[#0a0a0b] shadow-lg overflow-hidden">
          <div className="px-2 py-1.5 border-b border-[#17171a]">
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="w-full bg-transparent text-[12px] text-[#ededed] placeholder:text-[#555] outline-none"
            />
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            <button
              type="button"
              disabled={saving || override === null}
              onClick={() => applyChoice(null)}
              className={`w-full flex items-center justify-between px-3 py-1.5 text-left text-[11px] hover:bg-[#11111480] ${override === null ? "opacity-50" : ""}`}
            >
              <span className="text-[#ededed]">Use default</span>
              <span className="text-[#5a5a61]">{codeModel ? `→ ${shortLabel(codeModel)} (from code)` : globalMain ? `→ ${shortLabel(globalMain)} (global)` : ""}</span>
            </button>
            {catalog === null ? (
              <div className="px-3 py-2 text-[11px] text-[#5a5a61]">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-[#5a5a61]">{query ? "No matches" : "No models in catalog"}</div>
            ) : (
              filtered.map((m) => {
                const active = override === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={saving}
                    onClick={() => applyChoice(m.id)}
                    className={`w-full flex items-center justify-between px-3 py-1.5 text-left text-[11px] hover:bg-[#11111480] ${active ? "bg-[#11111480]" : ""}`}
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="font-mono text-[#ededed] truncate">{m.id}</span>
                      {m.name && m.name !== m.id && (
                        <span className="text-[10px] text-[#5a5a61] truncate">{m.name}</span>
                      )}
                    </div>
                    {active && <span className="text-[10px] text-emerald-400 shrink-0">selected</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { mutate } from "swr";
import { AgentInput } from "@/components/agent-input";
import { AgentPanel } from "@/components/agent-panel";
import { Button } from "@/components/button";
import { BusyFrame } from "@/components/busy-frame";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ConnectionTag } from "@/components/connection-tag";
import { DraftBanner } from "@/components/draft-banner";
import { HighlightedCode } from "@/components/highlighted-code";
import { RunSteps, type RunStep } from "@/components/run-steps";
import { useAgent } from "@/hooks/use-agent";
import { closeAgentSession } from "@/lib/api";
import { toast } from "@/components/toast";
import { PaneHeader } from "@/components/pane-header";
import { PaneSection } from "@/components/pane-section";
import { SegmentedControl } from "@/components/segmented-control";
import { EmptyState } from "@/components/state-panel";

function prettifyJigName(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function SkeletonLine({ width, className = "" }: { width: string; className?: string }) {
  return (
    <div
      className={`h-3 rounded-full bg-[#1a1a1d] ${className}`}
      style={{ width }}
    />
  );
}

function SkeletonSteps() {
  return (
    <div className="rounded-lg border border-[#1f1f23] bg-[#111113]">
      {[0, 1].map((step, idx, all) => (
        <div
          key={step}
          className={`flex items-start gap-3 px-4 py-3 ${idx < all.length - 1 ? "border-b border-dashed border-[#1a1a1d]" : ""}`}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1d] text-[10px] font-mono text-[#444] mt-0.5">
            {idx + 1}
          </span>
          <div className="flex-1 min-w-0">
            <SkeletonLine width={idx % 2 === 0 ? "55%" : "42%"} />
            <div className="mt-2 space-y-1.5">
              <SkeletonLine width="30%" className="h-2" />
              <SkeletonLine width="22%" className="h-2" />
            </div>
          </div>
          <SkeletonLine width="18px" className="h-2 shrink-0 mt-1" />
        </div>
      ))}
    </div>
  );
}

export function CreateJigPane({
  initialInstruction = "",
  startToken = 0,
  resumeSessionId,
  onClose,
  onCreated,
  onConnectionClick,
}: {
  initialInstruction?: string;
  startToken?: number;
  resumeSessionId?: string | null;
  onClose: () => void;
  onCreated?: (jigId?: string) => Promise<void> | void;
  onConnectionClick?: (name: string) => void;
}) {
  const [input, setInput] = useState(initialInstruction);
  const [detailTab, setDetailTab] = useState<"steps" | "code">("steps");
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  const handleCopyCode = async () => {
    if (!previewJig?.code) return;
    try {
      await navigator.clipboard.writeText(previewJig.code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch {
      toast.error("Failed to copy code");
    }
  };
  const startedTokenRef = useRef(0);
  const resumedSessionRef = useRef<string | null>(null);
  const listedDraftRef = useRef<string | null>(null);
  const agent = useAgent(async (jigId) => {
    await onCreated?.(jigId);
  }, { persistOnUnmount: true });
  const resumeAgentSession = agent.resumeSession;
  const displayName = agent.jigId ? prettifyJigName(agent.jigId) : "Create New Jig";
  const previewJig = agent.draftApproval?.jig ?? null;
  const discardSessionId = agent.sessionId ?? resumeSessionId ?? null;

  useEffect(() => {
    setInput(initialInstruction);
  }, [initialInstruction]);

  useEffect(() => {
    if (!startToken || startedTokenRef.current === startToken) return;
    startedTokenRef.current = startToken;
    setInput(initialInstruction);
  }, [initialInstruction, startToken]);

  useEffect(() => {
    if (!resumeSessionId || resumedSessionRef.current === resumeSessionId) return;
    resumedSessionRef.current = resumeSessionId;
    void resumeAgentSession(resumeSessionId);
  }, [resumeAgentSession, resumeSessionId]);

  useEffect(() => {
    if (!agent.jigId || listedDraftRef.current === agent.jigId) return;
    listedDraftRef.current = agent.jigId;
    void mutate("jigs");
  }, [agent.jigId]);

  const steps: RunStep[] = previewJig?.steps?.map((s) => ({
    num: s.num,
    name: s.name,
    connections: s.connections,
    tools: s.tools,
  })) ?? [];
  const hasData = previewJig !== null;
  const showAgentLoadingFrame = agent.isActive;

  const handleDiscardDraft = async () => {
    if (!discardSessionId || discarding) return;
    setDiscarding(true);
    try {
      await agent.reset();
      await closeAgentSession(discardSessionId);
      await mutate("jigs");
      setConfirmDiscardOpen(false);
      onClose();
    } catch (error: any) {
      toast.error(error?.message ?? "Failed to discard draft");
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <aside
      className="flex h-full w-full flex-col bg-[#0e0e10] overflow-hidden"
    >
      <ConfirmDialog
        open={confirmDiscardOpen}
        title="Discard draft?"
        message="This will remove the under-construction jig and any draft code that has been generated for it."
        confirmLabel="Discard Draft"
        destructive
        loading={discarding}
        onConfirm={handleDiscardDraft}
        onClose={() => !discarding && setConfirmDiscardOpen(false)}
      />

      <DraftBanner title="Draft under construction" />

      <BusyFrame busy={showAgentLoadingFrame} className="mx-3 my-3 flex-1 min-h-0" innerClassName="flex h-full min-h-0 flex-col">
          <PaneHeader
            title={
              <span key={displayName} style={{ animation: "fade-up 0.18s ease" }}>
                {displayName}
              </span>
            }
            badge={<span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-400">draft</span>}
            actions={
              <>
                {discardSessionId && (
                  <Button
                    onClick={() => setConfirmDiscardOpen(true)}
                    disabled={discarding}
                    variant="danger"
                    size="sm"
                    title="Discard draft"
                  >
                    {discarding ? "Discarding…" : "Discard"}
                  </Button>
                )}
                <Button onClick={onClose} variant="subtle" size="sm">
                  &#10005;
                </Button>
              </>
            }
          />

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
            <div className="flex items-center justify-between">
              <SegmentedControl
                value={detailTab}
                onChange={hasData ? setDetailTab : undefined}
                options={[
                  { value: "steps", label: "Steps" },
                  { value: "code", label: "Code", disabled: !hasData },
                ]}
              />
            </div>

            {detailTab === "steps" ? (
              hasData && steps.length > 0 ? (
                <div style={{ animation: "fade-up 0.2s ease" }}>
                  <RunSteps steps={steps} mode={{ type: "idle" }} />
                </div>
              ) : (
                showAgentLoadingFrame ? <SkeletonSteps /> : <EmptyState title="No draft steps yet" description="Describe the automation you want and the planner will build the first draft." />
              )
            ) : hasData ? (
              <div className="relative rounded-lg border border-[#1f1f23] bg-[#111113] p-4 font-mono overflow-x-auto" style={{ animation: "fade-up 0.15s ease" }}>
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="absolute right-3 top-3 z-10 rounded-md border border-[#2a2a2e] bg-[#0d0d0f] px-2 py-1 text-[10px] text-[#888] transition-colors hover:border-[#3a3a3e] hover:text-[#ededed]"
                  title="Copy code"
                >
                  {codeCopied ? "Copied" : "Copy"}
                </button>
                <HighlightedCode code={previewJig!.code} connections={previewJig!.settings.connections} />
              </div>
            ) : null}

            <PaneSection title="Trigger">
              {hasData && previewJig!.trigger ? (
                <span className="inline-flex items-center rounded-lg border border-[#2a2a2e] bg-[#1a1a1d] px-3 py-2 text-[12px] font-mono text-[#ccc]" style={{ animation: "fade-up 0.15s ease" }}>
                  {previewJig!.trigger}
                </span>
              ) : (
                <div className="rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-3">
                  <SkeletonLine width="120px" />
                </div>
              )}
            </PaneSection>

            <PaneSection title="Connections">
              {hasData && previewJig!.settings.connections.length > 0 ? (
                <div className="flex flex-wrap gap-2" style={{ animation: "fade-up 0.15s ease" }}>
                  {previewJig!.settings.connections.map((c) => (
                    <ConnectionTag key={c} name={c} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full border border-[#1f1f23] bg-[#111113] px-2.5 py-1.5 text-[10px] text-[#444]">connection</span>
                  <span className="rounded-full border border-[#1f1f23] bg-[#111113] px-2.5 py-1.5 text-[10px] text-[#444]">connection</span>
                  <span className="rounded-full border border-[#1f1f23] bg-[#111113] px-2.5 py-1.5 text-[10px] text-[#444]">connection</span>
                </div>
              )}
            </PaneSection>
          </div>

          <AgentPanel
            events={agent.events}
            status={agent.status}
            requiredConnections={agent.requiredConnections}
            suggestedConnections={agent.suggestedConnections}
            metrics={agent.metrics}
            onConnectionClick={onConnectionClick}
            onRetry={() => agent.sendMessage("Continue — retry the last step.")}
          />

          {agent.draftApproval?.jig && (
            <div className="border-t border-[#1f1f23] px-4 py-3">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-emerald-300">Draft Ready</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-emerald-100/70">
                    Approve to create this jig and allow its detected tools. Or type feedback below to revise the draft.
                  </p>
                </div>
                <Button onClick={() => void agent.approveDraft()} variant="success" size="xs">
                  Approve Draft
                </Button>
              </div>
            </div>
          )}

          <div className="border-t border-[#1f1f23] p-3">
            <AgentInput
              agent={agent}
              idlePlaceholder="Describe a jig to create..."
              variant="create"
              externalValue={input}
              onExternalValueChange={setInput}
              autoFocus
            />
          </div>
      </BusyFrame>
    </aside>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import type { JigData } from "@shared/api";
import { AgentInput } from "@/components/agent-input";
import { AgentPanel } from "@/components/agent-panel";
import { Button } from "@/components/button";
import { ConnectionTag } from "@/components/connection-tag";
import { HighlightedCode } from "@/components/highlighted-code";
import { RunSteps, type RunStep } from "@/components/run-steps";
import { useAgent } from "@/hooks/use-agent";
import { fetchJig } from "@/lib/api";
import { PaneHeader } from "@/components/pane-header";
import { PaneSection } from "@/components/pane-section";
import { SegmentedControl } from "@/components/segmented-control";

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
  onClose,
  onCreated,
}: {
  initialInstruction?: string;
  startToken?: number;
  onClose: () => void;
  onCreated?: (jigId?: string) => Promise<void> | void;
}) {
  const [input, setInput] = useState(initialInstruction);
  const [detailTab, setDetailTab] = useState<"steps" | "code">("steps");
  const [jigData, setJigData] = useState<JigData | null>(null);
  const startedTokenRef = useRef(0);
  const lastWriteCountRef = useRef(0);
  const agent = useAgent(async (jigId) => {
    await onCreated?.(jigId);
  });
  const displayName = agent.jigId ? prettifyJigName(agent.jigId) : "Create New Jig";

  // Fetch jig data whenever agent completes a write_jig_file call
  useEffect(() => {
    const writeCount = agent.events.filter(
      (e) => e.type === "tool-call" && e.tool === "write_jig_file" && e.status === "done"
    ).length;
    if (writeCount > lastWriteCountRef.current && agent.jigId) {
      lastWriteCountRef.current = writeCount;
      // Small delay to let the server process the file write
      const timer = setTimeout(() => {
        fetchJig(agent.jigId!).then(setJigData).catch(() => {});
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [agent.events, agent.jigId]);

  useEffect(() => {
    setInput(initialInstruction);
  }, [initialInstruction]);

  useEffect(() => {
    if (!startToken || startedTokenRef.current === startToken) return;
    startedTokenRef.current = startToken;
    setInput(initialInstruction);
  }, [agent, initialInstruction, startToken]);

  const steps: RunStep[] = jigData?.steps?.map((s) => ({
    num: s.num,
    name: s.name,
    connections: s.connections,
    tools: s.tools,
  })) ?? [];
  const hasData = jigData !== null;

  return (
    <aside
      className="flex h-full w-full flex-col bg-[#0e0e10] overflow-hidden"
    >
      <div className="construction-stripe border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
        <span className="text-amber-400 text-[11px]">&#9888;</span>
        <span className="text-[11px] text-amber-400 font-medium">Draft &mdash; under construction</span>
      </div>

      <PaneHeader
        title={
          <span key={displayName} style={{ animation: "fade-up 0.18s ease" }}>
            {displayName}
          </span>
        }
        badge={<span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-400">draft</span>}
        actions={
          <Button onClick={onClose} variant="subtle" size="sm">
            &#10005;
          </Button>
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
          <div className="flex items-center gap-1.5">
            <Button variant="subtle" size="xs" className="bg-[#1a1a1d] text-[#444] hover:bg-[#1a1a1d] hover:text-[#444]" disabled>
              Run
            </Button>
            <Button variant="subtle" size="xs" className="text-[#444] hover:text-[#444]" disabled>
              Dry Run
            </Button>
          </div>
        </div>

        {detailTab === "steps" ? (
          hasData && steps.length > 0 ? (
            <div style={{ animation: "fade-up 0.2s ease" }}>
              <RunSteps steps={steps} mode={{ type: "idle" }} />
            </div>
          ) : (
            <SkeletonSteps />
          )
        ) : hasData ? (
          <div className="rounded-lg border border-[#1f1f23] bg-[#111113] p-4 font-mono overflow-x-auto" style={{ animation: "fade-up 0.15s ease" }}>
            <HighlightedCode code={jigData!.code} connections={jigData!.settings.connections} />
          </div>
        ) : null}

        <PaneSection title="Trigger">
          {hasData && jigData!.trigger ? (
            <span className="inline-flex items-center rounded-lg border border-[#2a2a2e] bg-[#1a1a1d] px-3 py-2 text-[12px] font-mono text-[#ccc]" style={{ animation: "fade-up 0.15s ease" }}>
              {jigData!.trigger}
            </span>
          ) : (
            <div className="rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-3">
              <SkeletonLine width="120px" />
            </div>
          )}
        </PaneSection>

        <PaneSection title="Connections">
          {hasData && jigData!.settings.connections.length > 0 ? (
            <div className="flex flex-wrap gap-2" style={{ animation: "fade-up 0.15s ease" }}>
              {jigData!.settings.connections.map((c) => (
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

      <AgentPanel events={agent.events} status={agent.status} onRetry={() => agent.sendMessage("Continue — retry the last step.")} />

      <div className="border-t border-[#1f1f23] p-3">
        <AgentInput
          agent={agent}
          idlePlaceholder="Describe a jig to create..."
          variant="create"
          externalValue={input}
        />
      </div>
    </aside>
  );
}

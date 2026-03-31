"use client";

import { useEffect, useRef, useState } from "react";
import { AgentPanel } from "@/components/agent-panel";
import { Button } from "@/components/button";
import { useAgent } from "@/hooks/use-agent";
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
  const startedTokenRef = useRef(0);
  const agent = useAgent(async (jigId) => {
    await onCreated?.(jigId);
  });
  const displayName = agent.jigId ? prettifyJigName(agent.jigId) : "Create New Jig";

  useEffect(() => {
    setInput(initialInstruction);
  }, [initialInstruction]);

  useEffect(() => {
    if (!startToken || startedTokenRef.current === startToken) return;
    const trimmed = initialInstruction.trim();
    startedTokenRef.current = startToken;
    setInput(initialInstruction);
  }, [agent, initialInstruction, startToken]);

  function handleSend() {
    const instruction = input.trim();
    if (!instruction || agent.isActive) return;

    if (agent.sessionId && (agent.status === "done" || agent.status === "error")) {
      agent.sendMessage(instruction);
    } else {
      agent.startSession(instruction);
    }
  }

  return (
    <aside
      className="flex h-full w-full flex-col bg-[#0e0e10] overflow-hidden"
    >
      <div className="construction-stripe border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
        <span className="text-amber-400 text-[11px]">&#9888;</span>
        <span className="text-[11px] text-amber-400 font-medium">Draft &mdash; under construction</span>
        <span className="text-[10px] text-amber-400/50 ml-auto">Name it, describe it, then create</span>
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
            value="steps"
            options={[
              { value: "steps", label: "Steps" },
              { value: "code", label: "Code", disabled: true },
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

        <PaneSection title="Trigger">
          <div className="rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-3">
            <SkeletonLine width="120px" />
          </div>
        </PaneSection>

        <PaneSection title="Connections">
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-[#1f1f23] bg-[#111113] px-2.5 py-1.5 text-[10px] text-[#444]">connection</span>
            <span className="rounded-full border border-[#1f1f23] bg-[#111113] px-2.5 py-1.5 text-[10px] text-[#444]">connection</span>
            <span className="rounded-full border border-[#1f1f23] bg-[#111113] px-2.5 py-1.5 text-[10px] text-[#444]">connection</span>
          </div>
        </PaneSection>

      </div>

      <AgentPanel events={agent.events} status={agent.status} />

      <div className="border-t border-[#1f1f23] p-3">
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] px-3 py-2 shadow-[0_0_0_1px_rgba(245,158,11,0.06)]">
          <div className="mb-2 flex items-center gap-2">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500/10 text-[9px] font-medium text-amber-400">1</span>
            <span className="text-[10px] font-medium uppercase tracking-wider text-amber-400/80">Describe The Workflow</span>
          </div>
          {agent.sessionId && (
            <div className="mb-2 flex items-center justify-end">
              <span className="text-[10px] text-amber-400/50">
                {agent.jigId ? `Creating ${agent.jigId}` : "Choosing a name and shaping the draft"}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
            placeholder={agent.sessionId ? "Follow up..." : "Describe a jig to create..."}
            disabled={agent.isActive}
            className="flex-1 bg-transparent text-[12px] text-[#f2ead6] outline-none placeholder:text-[#9a8452] disabled:opacity-50"
          />
          {(agent.status === "done" || agent.status === "error") && (
            <Button
              onClick={agent.reset}
              variant="subtle"
              size="xs"
              className="border-amber-500/15 bg-transparent text-[#8d7a52] hover:border-amber-500/30 hover:bg-transparent hover:text-[#f0ddb3]"
            >
              Clear
            </Button>
          )}
          <Button
            onClick={handleSend}
            disabled={!input.trim() || agent.isActive}
            variant="success"
            size="xs"
          >
            {agent.sessionId ? "Send" : "Create"}
          </Button>
        </div>
        </div>
      </div>
    </aside>
  );
}

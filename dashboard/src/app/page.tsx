"use client";

import { useState } from "react";
import type { Phase, Jig } from "@/types/jig";
import { CHAT_MESSAGES, JIGS_WEEK2, JIGS_MONTH3 } from "@/lib/mock-data";
import { useResizablePane } from "@/hooks/use-resizable-pane";
import { ChatPanel } from "@/components/chat-panel";
import { OnboardingView } from "@/components/onboarding-view";
import { JigList } from "@/components/jig-list";
import { JigDetailPane } from "@/components/jig-detail-pane";
import { ReviewPane } from "@/components/review-pane";
import { ApprovalPane } from "@/components/approval-pane";

export default function Page() {
  const [phase, setPhase] = useState<Phase>("week2");
  const [selectedJig, setSelectedJig] = useState<string | null>(null);
  const [activeApproval, setActiveApproval] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [jigOrderWeek2, setJigOrderWeek2] = useState<Jig[]>(JIGS_WEEK2);
  const [jigOrderMonth3, setJigOrderMonth3] = useState<Jig[]>(JIGS_MONTH3);

  const { width: chatWidth, startResize: startChatResize } = useResizablePane({ initial: 280, min: 200, max: 600 });

  const allJigs = phase === "day1" ? [] : phase === "week2" ? jigOrderWeek2 : jigOrderMonth3;
  const setJigs = phase === "week2" ? setJigOrderWeek2 : setJigOrderMonth3;
  const currentJig = allJigs.find(j => j.id === selectedJig) ?? null;

  function handleJigClick(jig: Jig) {
    if (jig.grouped) {
      setExpandedGroup(expandedGroup === jig.id ? null : jig.id);
    } else {
      setSelectedJig(jig.id);
      setActiveApproval(null);
      setReviewMode(false);
      setSelectedEntity(null);
    }
  }

  function handleEntityClick(entity: string) {
    setSelectedEntity(entity);
    setSelectedJig(expandedGroup);
    setActiveApproval(null);
    setReviewMode(false);
    setExpandedGroup(null);
  }

  function closeDetail() {
    setSelectedJig(null);
    setSelectedEntity(null);
    setActiveApproval(null);
    setReviewMode(false);
  }

  function handleReviewClick(jigId: string) {
    setSelectedJig(jigId);
    setReviewMode(true);
    setActiveApproval(null);
    setSelectedEntity(null);
  }

  function handleApprovalClick(approvalId: string) {
    setActiveApproval(approvalId);
    setSelectedJig(null);
    setReviewMode(false);
  }

  return (
    <div className="flex h-full" style={{ background: "#0a0a0b" }}>
      {/* ────────────────────── LEFT: Chat Panel ────────────────────── */}
      <ChatPanel messages={CHAT_MESSAGES} width={chatWidth} onReviewClick={handleReviewClick} />

      {/* ── Chat resize handle ── */}
      <div
        onMouseDown={(e) => { startChatResize(); (e.target as HTMLElement).setAttribute("data-dragging", "true"); }}
        onMouseUp={(e) => (e.target as HTMLElement).removeAttribute("data-dragging")}
        className="w-[4px] shrink-0 cursor-col-resize hover:bg-[#2a2a2e] data-[dragging]:bg-blue-500/40 transition-colors duration-150"
      />

      {/* ────────────────────── CENTER+RIGHT: Content ────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Main list area ── */}
        <main className={`flex flex-col overflow-hidden transition-all duration-200 ${(selectedJig || activeApproval) ? "w-[52%]" : "w-full"}`}>
          {/* Top bar */}
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-5">
            <div className="flex items-center gap-4">
              <span className="text-[13px] font-medium text-[#ededed]">Your Jigs</span>
              {phase !== "day1" && (
                <span />
              )}
            </div>

            {/* Phase toggle */}
            <div className="flex items-center gap-0.5 rounded-lg border border-[#1f1f23] bg-[#0e0e10] p-0.5">
              {([["day1", "Day 1"], ["week2", "Week 2"], ["month3", "Month 3"]] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => { setPhase(key); closeDetail(); setExpandedGroup(null); }}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 ${phase === key ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {phase === "day1" && <OnboardingView />}
            {phase !== "day1" && (
              <JigList
                jigs={allJigs}
                selectedJigId={selectedJig}
                expandedGroup={expandedGroup}
                onJigClick={handleJigClick}
                onEntityClick={handleEntityClick}
                onReorder={setJigs}
                onExpandGroup={setExpandedGroup}
                onApprovalClick={handleApprovalClick}
                phase={phase}
              />
            )}
          </div>
        </main>

        {/* ────────────────────── RIGHT: Jig Detail ────────────────── */}
        {selectedJig && currentJig && !activeApproval && !reviewMode && (
          <JigDetailPane jig={currentJig} selectedEntity={selectedEntity} onClose={closeDetail} />
        )}

        {/* ────────────────────── RIGHT: Review (Draft Jig) ────────────── */}
        {selectedJig && currentJig && reviewMode && (
          <ReviewPane jig={currentJig} onClose={closeDetail} />
        )}

        {/* ────────────────────── RIGHT: Approval ────────────────── */}
        {activeApproval && !selectedJig && (
          <ApprovalPane approvalId={activeApproval} onClose={() => setActiveApproval(null)} onApprove={() => {}} onReject={() => {}} />
        )}
      </div>
    </div>
  );
}

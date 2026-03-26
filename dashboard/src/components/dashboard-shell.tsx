"use client";

import { useState } from "react";
import type { Phase, Jig, ChatMsg } from "@/types/jig";
import { useResizablePane } from "@/hooks/use-resizable-pane";
import { ChatPanel } from "@/components/chat-panel";
import { OnboardingView } from "@/components/onboarding-view";
import { JigList } from "@/components/jig-list";
import { JigDetailPane } from "@/components/jig-detail-pane";
import { ReviewPane } from "@/components/review-pane";
import { ApprovalPane } from "@/components/approval-pane";

export function DashboardShell({
  jigs: initialJigs,
  chatMessages,
  loading = false,
  phaseToggle = false,
  onPhaseChange,
}: {
  jigs: Jig[];
  chatMessages: ChatMsg[];
  loading?: boolean;
  phaseToggle?: boolean;
  onPhaseChange?: (phase: Phase) => void;
}) {
  const [phase, setPhase] = useState<Phase>("week2");
  const [selectedJig, setSelectedJig] = useState<string | null>(null);
  const [activeApproval, setActiveApproval] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [jigs, setJigs] = useState<Jig[]>(initialJigs);
  const [detailExpanded, setDetailExpanded] = useState(false);

  // Sync when parent changes jigs (e.g. phase change in mock mode)
  const [prevJigs, setPrevJigs] = useState(initialJigs);
  if (initialJigs !== prevJigs) {
    setPrevJigs(initialJigs);
    setJigs(initialJigs);
  }

  const { width: chatWidth, startResize: startChatResize } = useResizablePane({ initial: 280, min: 200, max: 600 });

  const currentJig = jigs.find(j => j.id === selectedJig) ?? null;
  const showOnboarding = phaseToggle ? phase === "day1" : jigs.length === 0 && !loading;

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

  function handlePhaseChange(p: Phase) {
    setPhase(p);
    closeDetail();
    setExpandedGroup(null);
    onPhaseChange?.(p);
  }

  return (
    <div className="flex h-full" style={{ background: "#0a0a0b" }}>
      <ChatPanel messages={chatMessages} width={chatWidth} onReviewClick={handleReviewClick} />

      <div
        onMouseDown={(e) => { startChatResize(); (e.target as HTMLElement).setAttribute("data-dragging", "true"); }}
        onMouseUp={(e) => (e.target as HTMLElement).removeAttribute("data-dragging")}
        className="w-[4px] shrink-0 cursor-col-resize hover:bg-[#2a2a2e] data-[dragging]:bg-blue-500/40 transition-colors duration-150"
      />

      <div className="flex flex-1 overflow-hidden">
        <main className={`flex flex-col overflow-hidden transition-all duration-200 ${detailExpanded ? "w-0 min-w-0 opacity-0" : (selectedJig || activeApproval) ? "w-[52%]" : "w-full"}`}>
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-5">
            <div className="flex items-center gap-4">
              <span className="text-[13px] font-medium text-[#ededed]">Your Jigs</span>
            </div>

            {phaseToggle && (
              <div className="flex items-center gap-0.5 rounded-lg border border-[#1f1f23] bg-[#0e0e10] p-0.5">
                {([["day1", "Day 1"], ["week2", "Week 2"], ["month3", "Month 3"]] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => handlePhaseChange(key)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 ${phase === key ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {loading && (
              <div className="flex items-center justify-center h-32 text-[#555] text-sm">Loading...</div>
            )}
            {showOnboarding && <OnboardingView />}
            {!showOnboarding && !loading && (
              <JigList
                jigs={jigs}
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

        {selectedJig && currentJig && !activeApproval && !reviewMode && (
          <JigDetailPane jig={currentJig} selectedEntity={selectedEntity} onClose={() => { setDetailExpanded(false); closeDetail(); }} onEdit={() => { setReviewMode(true); }} expanded={detailExpanded} onToggleExpand={() => setDetailExpanded(!detailExpanded)} />
        )}

        {selectedJig && currentJig && reviewMode && (
          <ReviewPane jig={currentJig} onClose={closeDetail} />
        )}

        {activeApproval && !selectedJig && (
          <ApprovalPane approvalId={activeApproval} onClose={() => setActiveApproval(null)} onApprove={() => {}} onReject={() => {}} />
        )}
      </div>
    </div>
  );
}

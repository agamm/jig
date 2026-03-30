"use client";

import { useState, useEffect } from "react";
import { useQueryState, parseAsString, parseAsBoolean } from "nuqs";
import type { Phase, Jig } from "@/types/jig";
import { OnboardingView } from "@/components/onboarding-view";
import { JigList } from "@/components/jig-list";
import { JigDetailPane } from "@/components/jig-detail-pane";
import { ReviewPane } from "@/components/review-pane";
import { ApprovalPane } from "@/components/approval-pane";
import { ConnectionPane } from "@/components/connection-pane";
import { ServiceIcon } from "@/components/service-icon";

function useLocalStorage(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const stored = localStorage.getItem(key);
    if (stored !== null) setValue(stored === "true");
  }, [key]);
  function set(v: boolean) {
    setValue(v);
    localStorage.setItem(key, String(v));
  }
  return [value, set];
}

export function DashboardShell({
  jigs: initialJigs,
  loading = false,
  phaseToggle = false,
  onPhaseChange,
}: {
  jigs: Jig[];
  loading?: boolean;
  phaseToggle?: boolean;
  onPhaseChange?: (phase: Phase) => void;
}) {
  const [phase, setPhase] = useState<Phase>("week2");
  const [selectedJig, setSelectedJig] = useQueryState("jig", parseAsString);
  const [selectedEntity, setSelectedEntity] = useQueryState("entity", parseAsString);
  const [selectedConnection, setSelectedConnection] = useQueryState("connection", parseAsString);
  const [activeApproval, setActiveApproval] = useQueryState("approval", parseAsString);
  const [reviewMode, setReviewMode] = useQueryState("review", parseAsBoolean.withDefault(false));
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [jigs, setJigs] = useState<Jig[]>(initialJigs);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [sidebarSlim, setSidebarSlim] = useLocalStorage("jig-sidebar-slim", false);
  const [view, setView] = useQueryState("view", parseAsString);

  // Sync when parent changes jigs (e.g. phase change in mock mode)
  const [prevJigs, setPrevJigs] = useState(initialJigs);
  if (initialJigs !== prevJigs) {
    setPrevJigs(initialJigs);
    setJigs(initialJigs);
  }

  const currentJig = jigs.find(j => j.id === selectedJig) ?? null;
  const showOnboarding = phaseToggle ? phase === "day1" : jigs.length === 0 && !loading;
  const hasDetail = (selectedJig && currentJig) || activeApproval || selectedConnection;
  const collapsed = sidebarSlim;
  const allConnections = [...new Set(jigs.flatMap(j => j.settings.connections))];

  function handleJigClick(jig: Jig) {
    if (jig.grouped) {
      setExpandedGroup(expandedGroup === jig.id ? null : jig.id);
    } else {
      setSelectedJig(jig.id);
      setActiveApproval(null);
      setReviewMode(null);
      setSelectedEntity(null);
      setSelectedConnection(null);
    }
  }

  function handleEntityClick(entity: string) {
    setSelectedEntity(entity);
    setSelectedJig(expandedGroup);
    setActiveApproval(null);
    setReviewMode(null);
    setSelectedConnection(null);
    setExpandedGroup(null);
  }

  function closeDetail() {
    setSelectedJig(null);
    setSelectedEntity(null);
    setActiveApproval(null);
    setReviewMode(null);
    setSelectedConnection(null);
  }

  function handleReviewClick(jigId: string) {
    setSelectedJig(jigId);
    setReviewMode(true);
    setActiveApproval(null);
    setSelectedEntity(null);
    setSelectedConnection(null);
  }

  function handleApprovalClick(approvalId: string) {
    setActiveApproval(approvalId);
    setSelectedJig(null);
    setReviewMode(null);
    setSelectedConnection(null);
  }

  function handlePhaseChange(p: Phase) {
    setPhase(p);
    closeDetail();
    setExpandedGroup(null);
    onPhaseChange?.(p);
  }

  return (
    <div className="flex h-full" style={{ background: "#0a0a0b" }}>
      {/* Nav sidebar */}
      <nav className={`flex shrink-0 flex-col border-r border-[#1f1f23] bg-[#0a0a0b] transition-all duration-200 overflow-hidden ${collapsed ? "w-[52px]" : "w-[180px]"}`}>
        {/* Header */}
        <div className={`flex h-11 shrink-0 items-center border-b border-[#1f1f23] gap-2 ${collapsed ? "justify-center px-0" : "px-3"}`}>
          <span className="h-[7px] w-[7px] rounded-full bg-emerald-400 shrink-0" />
          {!collapsed && <span className="text-[13px] font-semibold text-[#ededed]">Jig</span>}
        </div>

        {/* Nav items */}
        <div className="flex-1 flex flex-col gap-0.5 py-2">
          <NavItem icon={NavIcons.jigs} label="Jigs" active={!view || view === "jigs"} collapsed={collapsed} onClick={() => { setView(null); closeDetail(); }} />
          <NavItem icon={NavIcons.connections} label="Connections" active={view === "connections"} collapsed={collapsed} onClick={() => { setView("connections"); closeDetail(); }} />
          <NavItem icon={NavIcons.settings} label="Settings" active={view === "settings"} collapsed={collapsed} onClick={() => { setView("settings"); closeDetail(); }} />
        </div>

        {/* Models */}
        {!collapsed && (
          <div className="border-t border-[#1f1f23] px-3 py-2.5">
            <span className="text-[9px] text-[#444] uppercase tracking-wider">Models</span>
            <div className="mt-1.5 space-y-1.5">
              <div>
                <span className="text-[9px] text-[#555]">Main</span>
                <div className="text-[10px] text-[#888] font-mono truncate" title="anthropic/claude-haiku-4.5">claude-haiku-4.5</div>
              </div>
              <div>
                <span className="text-[9px] text-[#555]">Editor</span>
                <div className="text-[10px] text-[#888] font-mono truncate" title="deepseek/deepseek-v3.2">deepseek-v3.2</div>
              </div>
              <div>
                <span className="text-[9px] text-[#555]">Fast</span>
                <div className="text-[10px] text-[#888] font-mono truncate" title="nvidia/nemotron-3-super-120b-a12b:free">nemotron-3-super</div>
              </div>
            </div>
          </div>
        )}
        {collapsed && (
          <div className="border-t border-[#1f1f23] py-2 flex flex-col items-center gap-1">
            <span className="text-[9px] text-[#444]" title="Models">AI</span>
          </div>
        )}

        {/* Collapse toggle */}
        <div className={`border-t border-[#1f1f23] py-2 ${collapsed ? "px-1" : "px-2"}`}>
          <button
            onClick={() => setSidebarSlim(!sidebarSlim)}
            className={`flex items-center gap-2 rounded-md w-full py-1.5 text-[11px] text-[#444] hover:text-[#888] hover:bg-[#111113] transition-colors duration-150 ${collapsed ? "justify-center px-0" : "px-2"}`}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg className={`w-3.5 h-3.5 transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="11 17 6 12 11 7" />
              <polyline points="18 17 13 12 18 7" />
            </svg>
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </nav>

      <div className="flex flex-1 overflow-hidden">
        {/* Connections view */}
        {view === "connections" && (
          <main className="flex flex-col flex-1 overflow-hidden">
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-4">
              <span className="text-[13px] font-medium text-[#ededed]">Connections</span>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="max-w-2xl mx-auto space-y-3">
                {allConnections.map(c => (
                  <button
                    key={c}
                    onClick={() => { setView(null); setSelectedConnection(c); }}
                    className="flex w-full items-center gap-3 rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-3 transition-colors duration-150 hover:border-[#2a2a2e] hover:bg-[#141416]"
                  >
                    <ServiceIcon name={c} size={18} />
                    <span className="text-[13px] text-[#ededed] capitalize">{c}</span>
                    <span className="ml-auto h-2 w-2 rounded-full bg-emerald-400" />
                    <span className="text-[11px] text-[#555]">Connected</span>
                  </button>
                ))}
                <button className="flex w-full items-center gap-2 rounded-lg border border-dashed border-[#2a2a2e] px-4 py-3 text-[12px] text-[#555] transition-colors duration-150 hover:text-emerald-400 hover:border-emerald-400/30">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-[#2a2a2e] text-[11px]">+</span>
                  Add connection
                </button>
              </div>
            </div>
          </main>
        )}

        {/* Settings view */}
        {view === "settings" && (
          <main className="flex flex-col flex-1 overflow-hidden">
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-4">
              <span className="text-[13px] font-medium text-[#ededed]">Settings</span>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="max-w-2xl mx-auto space-y-6">
                <div className="space-y-3">
                  <h3 className="text-[12px] text-[#555] uppercase tracking-wider">LLM Provider</h3>
                  <div className="rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] text-[#ededed]">Anthropic — Claude Sonnet 4.6</span>
                      <span className="text-[11px] text-[#555] rounded-md border border-[#1f1f23] px-2 py-0.5">Change</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <h3 className="text-[12px] text-[#555] uppercase tracking-wider">Dashboard</h3>
                  <div className="rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] text-[#ccc]">Port</span>
                      <span className="text-[13px] text-[#888] font-mono">3141</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <h3 className="text-[12px] text-[#555] uppercase tracking-wider">Standing Permissions</h3>
                  <div className="rounded-lg border border-dashed border-[#1f1f23] px-4 py-6 text-center">
                    <p className="text-[12px] text-[#444]">Permissions are configured in jig.config.ts</p>
                  </div>
                </div>
              </div>
            </div>
          </main>
        )}

        {/* Jigs view (default) */}
        {(!view || view === "jigs") && (
        <main className={`flex flex-col overflow-hidden transition-all duration-200 ${detailExpanded ? "w-0 min-w-0 opacity-0" : hasDetail ? "w-[52%]" : "w-full"}`}>
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-4">
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

          <div className="flex-1 overflow-y-auto px-4 py-4">
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

          {/* Command bar chat */}
          <div className="shrink-0 border-t border-[#1f1f23] px-4 py-2.5">
            <div className="flex items-center gap-2 rounded-lg border border-[#1f1f23] bg-[#111113] px-3 py-2 text-[12px] text-[#444] cursor-text transition-colors duration-150 hover:border-[#2a2a2e] hover:text-[#555]">
              <svg className="w-3.5 h-3.5 text-[#555]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              <span className="flex-1">Jig anything...</span>
              <kbd className="rounded bg-[#1a1a1d] px-1.5 py-0.5 text-[10px] text-[#555] font-mono">⌘K</kbd>
            </div>
          </div>
        </main>
        )}

        {selectedJig && currentJig && !activeApproval && !reviewMode && !selectedConnection && (
          <JigDetailPane
            jig={currentJig}
            selectedEntity={selectedEntity}
            onClose={() => { setDetailExpanded(false); closeDetail(); }}
            expanded={detailExpanded}
            onToggleExpand={() => setDetailExpanded(!detailExpanded)}
            onConnectionClick={(name) => { setSelectedConnection(name); }}
            onRefresh={async () => {
              try {
                const res = await fetch(`/api/jigs/${encodeURIComponent(selectedJig)}`)
                if (res.ok) {
                  const updated = await res.json()
                  setJigs(prev => prev.map(j => j.id === updated.id ? updated : j))
                }
              } catch {}
            }}
          />
        )}

        {selectedConnection && (
          <ConnectionPane
            name={selectedConnection}
            onClose={() => setSelectedConnection(null)}
            onJigClick={(jigId) => { setSelectedConnection(null); setSelectedJig(jigId); setReviewMode(null); }}
          />
        )}

        {selectedJig && currentJig && reviewMode && !selectedConnection && (
          <ReviewPane jig={currentJig} onClose={closeDetail} />
        )}

        {activeApproval && !selectedJig && !selectedConnection && (
          <ApprovalPane approvalId={activeApproval} onClose={() => setActiveApproval(null)} onApprove={() => {}} onReject={() => {}} />
        )}
      </div>
    </div>
  );
}

function NavItem({ icon, label, active, collapsed, onClick }: { icon: React.ReactNode; label: string; active?: boolean; collapsed: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-2.5 rounded-md py-1.5 text-[12px] transition-colors duration-150 ${collapsed ? "justify-center mx-1 px-0" : "mx-2 px-2.5"} ${active ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#666] hover:text-[#999] hover:bg-[#111113]"}`}>
      <span className="shrink-0 [&>svg]:w-[14px] [&>svg]:h-[14px]">{icon}</span>
      {!collapsed && <span>{label}</span>}
    </button>
  );
}

const NavIcons = {
  jigs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  connections: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
      <path d="M9 17H7a5 5 0 0 1 0-10h2" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

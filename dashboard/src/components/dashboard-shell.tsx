"use client";

import { useState, useEffect } from "react";
import { useQueryState, parseAsString, parseAsBoolean } from "nuqs";
import { mutate } from "swr";
import type { Phase, Jig } from "@/types/jig";
import { OnboardingView } from "@/components/onboarding-view";
import { JigList } from "@/components/jig-list";
import { JigDetailPane } from "@/components/jig-detail-pane";
import { CreateJigPane } from "@/components/create-jig-pane";
import { ReviewPane } from "@/components/review-pane";
import { ConnectionPane } from "@/components/connection-pane";
import { NotificationsSettings } from "@/components/notifications-settings";
import { ServiceIcon } from "@/components/service-icon";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/resizable";
import { useConnectionCatalog } from "@/lib/hooks";
import { useModels, useConnections } from "@/lib/swr";
import { addExampleJig } from "@/lib/api";
import type { ExampleJig } from "@shared/api";

function useLocalStorage(key: string, initial: boolean): [boolean, (v: boolean) => void, boolean] {
  const [value, setValue] = useState(initial);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const stored = localStorage.getItem(key);
    if (stored !== null) setValue(stored === "true");
    setMounted(true);
  }, [key]);
  function set(v: boolean) {
    setValue(v);
    localStorage.setItem(key, String(v));
  }
  return [value, set, mounted];
}

export function DashboardShell({
  jigs: initialJigs,
  examples = [],
  loading = false,
  phaseToggle = false,
  onPhaseChange,
}: {
  jigs: Jig[];
  examples?: ExampleJig[];
  loading?: boolean;
  phaseToggle?: boolean;
  onPhaseChange?: (phase: Phase) => void;
}) {
  const [phase, setPhase] = useState<Phase>("week2");
  const [selectedJig, setSelectedJig] = useQueryState("jig", parseAsString);
  const [selectedConnection, setSelectedConnection] = useQueryState("connection", parseAsString);
  const [reviewMode, setReviewMode] = useQueryState("review", parseAsBoolean.withDefault(false));
  const jigs = initialJigs;
  const [sidebarSlim, setSidebarSlim, sidebarMounted] = useLocalStorage("jig-sidebar-slim", false);
  const [view, setView] = useQueryState("view", parseAsString);
  const [createOpen, setCreateOpen] = useState(false);
  const [createInstruction, setCreateInstruction] = useState("");
  const [createStartToken, setCreateStartToken] = useState(0);
  const { data: models } = useModels();
  const { data: connections, isLoading: connectionsLoading } = useConnections();

  const currentJig = jigs.find((j) => j.id === selectedJig) ?? null;
  const showOnboarding = phaseToggle ? phase === "day1" : jigs.length === 0 && !loading;
  const hasDetail = createOpen || (selectedJig && currentJig) || selectedConnection;
  const collapsed = sidebarMounted ? sidebarSlim : false;
  const {
    availableConnections,
    connectedCount,
    firstDisconnectedConnection,
  } = useConnectionCatalog(connections);

  function openJigDetail(jigId: string) {
    setCreateOpen(false);
    setView(null);
    setSelectedJig(jigId);
    setReviewMode(null);
    setSelectedConnection(null);
  }

  function handleJigClick(jig: Jig) {
    openJigDetail(jig.id);
  }

  function closeDetail() {
    setSelectedJig(null);
    setReviewMode(null);
    setSelectedConnection(null);
    setCreateOpen(false);
  }

  function openCreatePane(instruction = "", autoStart = false) {
    setSelectedJig(null);
    setReviewMode(null);
    setSelectedConnection(null);
    setView(null);
    setCreateOpen(true);
    setCreateInstruction(instruction);
    if (autoStart && instruction.trim()) {
      setCreateStartToken((prev) => prev + 1);
    }
  }

  async function refreshJigs(openJigId?: string) {
    await mutate("jigs")
    if (openJigId) {
      openJigDetail(openJigId)
    }
  }

  function handlePhaseChange(p: Phase) {
    setPhase(p);
    closeDetail();
    onPhaseChange?.(p);
  }

  const jigsPane = (
    <main className="flex h-full flex-1 flex-col overflow-hidden">
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
          <div className="flex h-32 items-center justify-center text-sm text-[#555]">Loading...</div>
        )}
        {showOnboarding && (
          <OnboardingView
            onCreate={() => openCreatePane()}
            onConnectionClick={(name) => {
              setView("connections");
              setSelectedConnection(name);
            }}
            onExampleAdd={async (id) => {
              const result = await addExampleJig(id);
              await refreshJigs(result.jigId);
            }}
            onExampleOpen={(id) => {
              openJigDetail(id);
            }}
            connectedCount={connectedCount}
            connections={availableConnections}
            examples={examples}
            existingJigIds={jigs.map((jig) => jig.id)}
          />
        )}
        {!showOnboarding && !loading && (
          <JigList
            jigs={jigs}
            selectedJigId={selectedJig}
            onJigClick={handleJigClick}
            onReorder={(reordered) => mutate("jigs", reordered, false)}
            onCreate={() => openCreatePane()}
          />
        )}
      </div>
    </main>
  );

  const connectionsMain = (
    <main className="flex flex-col flex-1 overflow-hidden h-full">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-4">
        <span className="text-[13px] font-medium text-[#ededed]">Connections</span>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-2xl mx-auto space-y-3">
          {connectionsLoading && availableConnections.length === 0 && (
            <div className="py-8 text-center text-[11px] text-[#555]">Loading connections…</div>
          )}
          {!connectionsLoading && availableConnections.length === 0 && (
            <div className="py-8 text-center text-[11px] text-[#555]">
              No connections yet. Run <code className="text-[10px] bg-[#1a1a1d] px-1 py-0.5 rounded font-mono">jig connect &lt;server&gt;</code> to add one.
            </div>
          )}
          {availableConnections.map((c) => (
            <button
              key={c.name}
              onClick={() => setSelectedConnection(c.name)}
              className={`relative flex w-full items-center gap-3 rounded-lg border px-4 py-3 transition-colors duration-150 ${selectedConnection === c.name ? "border-emerald-400/30 bg-[#15171a]" : "border-[#1f1f23] bg-[#111113] hover:border-[#2a2a2e] hover:bg-[#141416]"}`}
            >
              {selectedConnection === c.name && (
                <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r bg-emerald-400/60" />
              )}
              <ServiceIcon name={c.name} size={18} />
              <span className="text-[13px] text-[#ededed] capitalize">{c.name}</span>
              {c.proxyVia && (
                <span className="rounded-full border border-[#2a2a2e] bg-[#1a1a1d] px-1.5 py-0.5 text-[9px] font-medium text-[#888]" title={`Tools proxied via ${c.proxyVia}`}>
                  proxy
                </span>
              )}
              <span className="text-[11px] text-[#555]">{c.toolCount} tools</span>
              <span className={`ml-auto h-2 w-2 rounded-full ${c.connected ? "bg-emerald-400" : "bg-[#444]"}`} />
              <span className="text-[11px] text-[#555]">{c.connected ? "Connected" : "Available"}</span>
            </button>
          ))}
          <button
            onClick={() => firstDisconnectedConnection && setSelectedConnection(firstDisconnectedConnection.name)}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-[#2a2a2e] px-4 py-3 text-[12px] text-[#555] transition-colors duration-150 hover:text-emerald-400 hover:border-emerald-400/30"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-[#2a2a2e] text-[11px]">+</span>
            Connect a service
          </button>
        </div>
      </div>
    </main>
  );

  const detailPane =
    createOpen && !selectedConnection ? (
      <CreateJigPane
        initialInstruction={createInstruction}
        startToken={createStartToken}
        onClose={() => setCreateOpen(false)}
        onCreated={async (jigId) => {
          await refreshJigs(jigId);
        }}
      />
    ) : selectedJig && currentJig && !reviewMode && !selectedConnection ? (
      <JigDetailPane
        key={currentJig.id}
        jig={currentJig}
        onClose={closeDetail}
        onConnectionClick={(name) => {
          setSelectedConnection(name);
        }}
        onRefresh={() => mutate("jigs")}
        onDelete={async (deletedJigId) => {
          await mutate("jigs", (current: Jig[] | undefined) =>
            (current ?? []).filter((candidate) => candidate.id !== deletedJigId),
          false)
          closeDetail()
          await mutate("jigs")
        }}
      />
    ) : selectedConnection ? (
      <ConnectionPane
        name={selectedConnection}
        onClose={() => setSelectedConnection(null)}
        onJigClick={(jigId) => {
          openJigDetail(jigId);
        }}
      />
    ) : selectedJig && currentJig && reviewMode && !selectedConnection ? (
      <ReviewPane jig={currentJig} onClose={closeDetail} />
    ) : null;

  return (
    <div className="flex h-full" style={{ background: "#0a0a0b" }}>
      <nav className={`flex shrink-0 flex-col border-r border-[#1f1f23] bg-[#0a0a0b] transition-all duration-200 overflow-hidden ${collapsed ? "w-[52px]" : "w-[180px]"}`}>
        <div className={`flex h-11 shrink-0 items-center border-b border-[#1f1f23] ${collapsed ? "justify-center px-0" : "justify-between px-3"}`}>
          {!collapsed ? (
            <div className="flex items-center gap-2">
              <span className="h-[7px] w-[7px] rounded-full bg-emerald-400 shrink-0" />
              <span className="text-[13px] font-semibold text-[#ededed]">Jig</span>
            </div>
          ) : null}
          {!collapsed ? (
            <button
              onClick={() => setSidebarSlim(!sidebarSlim)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[#444] transition-colors duration-150 hover:bg-[#111113] hover:text-[#9a9aa3]"
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="11 17 6 12 11 7" />
                <polyline points="18 17 13 12 18 7" />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => setSidebarSlim(!sidebarSlim)}
              className="flex h-11 w-full items-center justify-center text-[#444] transition-colors duration-150 hover:bg-[#111113] hover:text-[#9a9aa3]"
              title="Expand sidebar"
              aria-label="Expand sidebar"
            >
              <svg className="h-3.5 w-3.5 rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="11 17 6 12 11 7" />
                <polyline points="18 17 13 12 18 7" />
              </svg>
            </button>
          )}
        </div>

        <div className="flex-1 flex flex-col gap-0.5 py-2">
          <NavItem icon={NavIcons.jigs} label="Jigs" active={!view || view === "jigs"} collapsed={collapsed} onClick={() => { setView(null); closeDetail(); }} />
          <NavItem icon={NavIcons.connections} label="Connections" active={view === "connections"} collapsed={collapsed} onClick={() => { setView("connections"); closeDetail(); }} />
          <NavItem icon={NavIcons.settings} label="Settings" active={view === "settings"} collapsed={collapsed} onClick={() => { setView("settings"); closeDetail(); }} />
        </div>

        {!collapsed && models && (
          <div className="border-t border-[#1f1f23] px-3 py-2.5">
            <span className="text-[9px] text-[#444] uppercase tracking-wider">Models</span>
            <div className="mt-1.5 space-y-1.5">
              {(["main", "editor", "fast"] as const).map((k) => models[k] && (
                <div key={k}>
                  <span className="text-[9px] text-[#555] capitalize">{k}</span>
                  <div className="text-[10px] text-[#888] font-mono truncate" title={models[k].id}>{models[k].label}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {collapsed && (
          <div className="border-t border-[#1f1f23] py-2 flex flex-col items-center gap-1">
            <span className="text-[9px] text-[#444]" title="Models">AI</span>
          </div>
        )}

      </nav>

      <div className="flex flex-1 overflow-hidden">
        {view === "connections" && (
          selectedConnection && detailPane ? (
            <ResizablePanelGroup direction="horizontal" className="flex-1">
              <ResizablePanel defaultSize="52%" minSize="0%">
                {connectionsMain}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize="48%" minSize="28%" maxSize="100%">
                {detailPane}
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            connectionsMain
          )
        )}

        {view === "settings" && (
          <main className="flex flex-col flex-1 overflow-hidden">
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-4">
              <span className="text-[13px] font-medium text-[#ededed]">Settings</span>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="max-w-2xl mx-auto space-y-6">
                <div className="rounded-xl border border-[#1f1f23] bg-[#0d0d0f] px-4 py-4">
                  <p className="text-[12px] leading-relaxed text-[#777]">
                    Configure local behavior for this workspace. Changes here affect only this machine unless the setting is stored in your repo.
                  </p>
                </div>
                <div className="space-y-3">
                  <h3 className="text-[12px] text-[#555] uppercase tracking-wider">LLM Provider</h3>
                  <div className="rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-3">
                    <p className="mb-2 text-[11px] text-[#666]">Default model used for the assistant and jig generation.</p>
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] text-[#ededed]">{models?.main?.id ?? "Loading..."}</span>
                      <span className="text-[11px] text-[#555] rounded-md border border-[#1f1f23] px-2 py-0.5">Change</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <h3 className="text-[12px] text-[#555] uppercase tracking-wider">Notifications</h3>
                  <NotificationsSettings
                    onReset={async () => {
                      closeDetail();
                      setView(null);
                      await mutate("jigs", [], false);
                      await mutate("examples");
                      await mutate("connections");
                    }}
                  />
                </div>
              </div>
            </div>
          </main>
        )}

        {(!view || view === "jigs") && (
          hasDetail && detailPane ? (
            <ResizablePanelGroup direction="horizontal" className="flex-1">
              <ResizablePanel defaultSize="52%" minSize="0%">
                {jigsPane}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize="48%" minSize="28%" maxSize="100%">
                {detailPane}
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            jigsPane
          )
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

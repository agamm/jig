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
import { LogsSettings } from "@/components/logs-settings";
import { ModelsSettings } from "@/components/models-settings";
import { SystemSettings } from "@/components/system-settings";
import { DangerSettings } from "@/components/danger-settings";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ModelUpgradeModal } from "@/components/model-upgrade-modal";
import { ServiceIcon } from "@/components/service-icon";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/resizable";
import { Button } from "@/components/button";
import { TextInput } from "@/components/input";
import { toast } from "@/components/toast";
import { EmptyState, LoadingState, Notice } from "@/components/state-panel";
import { isRecommendedConnection, sortConnectionsForDisplay } from "@/lib/connection-catalog";
import { useConnectionCatalog } from "@/lib/hooks";
import { useModels, useConnections, useHealth, useOpenRouterCredits } from "@/lib/swr";
import { APP_VERSION } from "@/lib/version";
import { addExampleJig, closeAgentSession, createCustomConnection, fetchModelUpgrades } from "@/lib/api";
import type { Connection, DataStorageHealth, ExampleJig, ModelUpgradeSuggestion } from "@shared/api";

/**
 * Derive the dot + label for a connection's runtime health. "connected" only
 * means a schema exists on disk; the `status` field (written at MCP failure
 * chokepoints) is what tells us a token expired or the server is unreachable.
 */
function connectionStatusDisplay(c: Connection): { dot: string; label: string; labelClass: string } {
  if (!c.connected) return { dot: "bg-[#444]", label: "Available", labelClass: "text-[#555]" };
  switch (c.status?.state) {
    case "auth-required":
      return { dot: "bg-amber-400", label: "Reconnect", labelClass: "text-amber-300" };
    case "unreachable":
      return { dot: "bg-rose-400", label: "Unreachable", labelClass: "text-rose-300" };
    default:
      return { dot: "bg-emerald-400", label: "Connected", labelClass: "text-[#555]" };
  }
}

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
  errorMessage,
  examplesErrorMessage,
  storageHealth,
  phaseToggle = false,
  onPhaseChange,
}: {
  jigs: Jig[];
  examples?: ExampleJig[];
  loading?: boolean;
  errorMessage?: string;
  examplesErrorMessage?: string;
  storageHealth?: DataStorageHealth;
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
  const [settingsFocus, setSettingsFocus] = useQueryState("settingsFocus", parseAsString);
  const [settingsTab, setSettingsTab] = useQueryState("tab", parseAsString);
  const [createOpen, setCreateOpen] = useState(false);
  const [createInstruction, setCreateInstruction] = useState("");
  const [createStartToken, setCreateStartToken] = useState(0);
  const [createResumeSessionId, setCreateResumeSessionId] = useState<string | null>(null);
  const [showCustomConnectionForm, setShowCustomConnectionForm] = useState(false);
  const [creatingCustomConnection, setCreatingCustomConnection] = useState(false);
  const [customConnectionName, setCustomConnectionName] = useState("");
  const [customConnectionUrl, setCustomConnectionUrl] = useState("");
  const [customConnectionDescription, setCustomConnectionDescription] = useState("");
  const [customConnectionStatus, setCustomConnectionStatus] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  const [draftToDiscard, setDraftToDiscard] = useState<Jig | null>(null);
  const [discardingDraft, setDiscardingDraft] = useState(false);
  const [modelUpgrades, setModelUpgrades] = useState<ModelUpgradeSuggestion[]>([]);

  // Fire-and-forget check for newer-better models in the same family. Runs
  // once per dashboard mount, fully off the render path so it never delays
  // first paint. Dismissing sets the list to [] and the effect's empty deps
  // mean we won't re-fetch this session.
  useEffect(() => {
    const controller = new AbortController();
    void fetchModelUpgrades({ signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res.suggestions.length > 0) setModelUpgrades(res.suggestions);
      })
      .catch(() => {
        // Best-effort — silent on network/abort errors.
      });
    return () => controller.abort();
  }, []);
  const { data: models } = useModels();
  const { data: connections, isLoading: connectionsLoading, error: connectionsError } = useConnections();
  const { data: health } = useHealth();
  const { data: credits } = useOpenRouterCredits();
  const [resendBannerDismissed, setResendBannerDismissed, resendBannerMounted] = useLocalStorage("jig-resend-banner-dismissed", false);
  // Prompt to set up out-of-band alerting once the workspace is in use (has at
  // least one jig) but Resend isn't configured — that's when an unattended
  // failure would actually go unnoticed. health is admin-gated, so
  // resend_configured is undefined until authed; only show on an explicit false.
  const showResendOnboarding =
    resendBannerMounted &&
    !resendBannerDismissed &&
    health?.resend_configured === false &&
    jigs.length > 0;

  function openResendSettings() {
    closeDetail();
    setView("settings");
    setSettingsTab("notifications");
  }

  const currentJig = jigs.find((j) => j.id === selectedJig) ?? null;
  const showOnboarding = !errorMessage && (phaseToggle ? phase === "day1" : jigs.length === 0 && !loading);
  const hasDetail = createOpen || (selectedJig && currentJig) || selectedConnection;
  const collapsed = sidebarMounted ? sidebarSlim : false;
  const {
    availableConnections,
    connectedCount,
    firstDisconnectedConnection,
  } = useConnectionCatalog(connections);
  const displayedConnections = sortConnectionsForDisplay(availableConnections);

  function openJigDetail(jigId: string) {
    setCreateOpen(false);
    setView(null);
    setSelectedJig(jigId);
    setReviewMode(null);
    setSelectedConnection(null);
  }

  function handleJigClick(jig: Jig) {
    if (jig.underConstruction) {
      setCreateOpen(false);
      setView(null);
      setSelectedJig(jig.id);
      setReviewMode(null);
      setSelectedConnection(null);
      setCreateResumeSessionId(jig.underConstruction.sessionId);
      return;
    }
    openJigDetail(jig.id);
  }

  function closeDetail() {
    setSelectedJig(null);
    setReviewMode(null);
    setSelectedConnection(null);
    setCreateOpen(false);
    setCreateResumeSessionId(null);
  }

  function openCreatePane(instruction = "", autoStart = false) {
    setSelectedJig(null);
    setReviewMode(null);
    setSelectedConnection(null);
    setView(null);
    setCreateOpen(true);
    setCreateResumeSessionId(null);
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

  async function confirmDiscardUnderConstruction() {
    const draft = draftToDiscard;
    const sessionId = draft?.underConstruction?.sessionId;
    if (!draft || !sessionId || discardingDraft) return;

    setDiscardingDraft(true);
    try {
      await closeAgentSession(sessionId);
      await mutate("jigs", (current: Jig[] | undefined) =>
        (current ?? []).filter((candidate) => candidate.id !== draft.id),
      false);
      if (selectedJig === draft.id) closeDetail();
      setDraftToDiscard(null);
      await mutate("jigs");
    } catch (error: any) {
      toast.error(error?.message ?? "Failed to discard draft");
    } finally {
      setDiscardingDraft(false);
    }
  }

  function handlePhaseChange(p: Phase) {
    setPhase(p);
    closeDetail();
    onPhaseChange?.(p);
  }

  async function handleCreateCustomConnection() {
    if (creatingCustomConnection) return;
    setCreatingCustomConnection(true);
    setCustomConnectionStatus(null);
    try {
      const result = await createCustomConnection({
        name: customConnectionName,
        url: customConnectionUrl,
        description: customConnectionDescription,
      });
      setCustomConnectionStatus({ tone: "success", message: `Added ${result.connection.name}.` });
      setCustomConnectionName("");
      setCustomConnectionUrl("");
      setCustomConnectionDescription("");
      setShowCustomConnectionForm(false);
      await mutate("connections");
      setSelectedConnection(result.connection.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add custom connection";
      setCustomConnectionStatus({ tone: "danger", message });
    } finally {
      setCreatingCustomConnection(false);
    }
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
        {storageHealth && !storageHealth.ok && (
          <Notice
            tone="danger"
            title="Persistent storage is not connected"
            className="mb-3"
          >
            {storageHealth.message} Run <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[10px] text-rose-100">{storageHealth.action}</code> from this checkout, then paste/save connection tokens again.
          </Notice>
        )}
        {showResendOnboarding && (
          <Notice
            tone="warning"
            title="Set up failure alerts"
            className="mb-3"
            actions={
              <div className="flex items-center gap-2">
                <Button onClick={openResendSettings} variant="accent" size="xs">Set up Resend</Button>
                <Button onClick={() => setResendBannerDismissed(true)} variant="subtle" size="xs">Dismiss</Button>
              </div>
            }
          >
            Running 24/7? Add a Resend API key so Jig emails you when a jig fails or a connection breaks — even when its own integrations are down.
          </Notice>
        )}
        {loading && <LoadingState message="Loading workspace…" className="h-32" />}
        {!loading && errorMessage && (
          <Notice
            tone="danger"
            title="Couldn’t load jigs"
            actions={<Button onClick={() => mutate("jigs")} variant="subtle" size="xs">Retry</Button>}
          >
            {errorMessage}
          </Notice>
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
            examplesErrorMessage={examplesErrorMessage}
          />
        )}
        {!showOnboarding && !loading && !errorMessage && (
          <JigList
            jigs={jigs}
            selectedJigId={selectedJig}
            onJigClick={handleJigClick}
            onReorder={(reordered) => mutate("jigs", reordered, false)}
            onCreate={() => openCreatePane()}
            onDiscardUnderConstruction={setDraftToDiscard}
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
          <div className="rounded-lg border border-[#1f1f23] bg-[#111113] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[13px] font-medium text-[#ededed]">Add custom MCP</p>
                <p className="mt-1 text-[11px] text-[#666]">Register any remote HTTP MCP server with a name, URL, and optional description.</p>
              </div>
              <Button
                onClick={() => {
                  setCustomConnectionStatus(null);
                  setShowCustomConnectionForm((prev) => !prev);
                }}
                variant={showCustomConnectionForm ? "subtle" : "accent"}
                size="sm"
              >
                {showCustomConnectionForm ? "Hide" : "Add custom"}
              </Button>
            </div>
            {showCustomConnectionForm && (
              <div className="mt-4 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#888]">Connection name</span>
                    <TextInput
                      value={customConnectionName}
                      onChange={(event) => setCustomConnectionName(event.target.value)}
                      placeholder="my-mcp"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#888]">MCP URL</span>
                    <TextInput
                      value={customConnectionUrl}
                      onChange={(event) => setCustomConnectionUrl(event.target.value)}
                      placeholder="https://example.com/mcp"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </label>
                </div>
                <label className="space-y-1.5 block">
                  <span className="text-[11px] text-[#888]">Description</span>
                  <TextInput
                    value={customConnectionDescription}
                    onChange={(event) => setCustomConnectionDescription(event.target.value)}
                    placeholder="Optional description"
                  />
                </label>
                <p className="text-[10px] leading-relaxed text-[#555]">Names must use lowercase letters, numbers, underscores, or hyphens. URLs must be absolute `http://` or `https://` MCP endpoints.</p>
                {customConnectionStatus && (
                  <Notice tone={customConnectionStatus.tone}>
                    {customConnectionStatus.message}
                  </Notice>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    onClick={handleCreateCustomConnection}
                    variant="successOutline"
                    size="sm"
                    disabled={creatingCustomConnection || !customConnectionName.trim() || !customConnectionUrl.trim()}
                  >
                    {creatingCustomConnection ? "Adding…" : "Save custom MCP"}
                  </Button>
                  <Button
                    onClick={() => {
                      setShowCustomConnectionForm(false);
                      setCustomConnectionStatus(null);
                    }}
                    variant="subtle"
                    size="sm"
                    disabled={creatingCustomConnection}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
          {connectionsLoading && availableConnections.length === 0 && (
            <LoadingState message="Loading connections…" />
          )}
          {!connectionsLoading && connectionsError && availableConnections.length === 0 && (
            <Notice
              tone="danger"
              title="Couldn’t load connections"
              actions={<Button onClick={() => mutate("connections")} variant="subtle" size="xs">Retry</Button>}
            >
              {connectionsError.message}
            </Notice>
          )}
          {!connectionsLoading && !connectionsError && availableConnections.length === 0 && (
            <EmptyState
              title="No connections yet"
              description={<><span>Run </span><code className="rounded bg-[var(--surface-muted)] px-1 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">jig connect &lt;server&gt;</code><span> to add one.</span></>}
            />
          )}
          {displayedConnections.map((c) => (
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
              {c.custom && (
                <span className="rounded-full border border-blue-500/20 bg-blue-500/[0.08] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-blue-300">
                  custom
                </span>
              )}
              {isRecommendedConnection(c.name) && (
                <span className="rounded-full border border-emerald-500/20 bg-emerald-500/[0.08] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-emerald-300">
                  recommended
                </span>
              )}
              {c.proxyVia && (
                <span className="rounded-full border border-[#2a2a2e] bg-[#1a1a1d] px-1.5 py-0.5 text-[9px] font-medium text-[#888]" title={`Tools proxied via ${c.proxyVia}`}>
                  proxy
                </span>
              )}
              <span className="text-[11px] text-[#555]">{c.toolCount} tools</span>
              {(() => {
                const st = connectionStatusDisplay(c);
                return (
                  <>
                    <span className={`ml-auto h-2 w-2 rounded-full ${st.dot}`} />
                    <span className={`text-[11px] ${st.labelClass}`}>{st.label}</span>
                  </>
                );
              })()}
            </button>
          ))}
          {firstDisconnectedConnection ? (
            <button
              onClick={() => setSelectedConnection(firstDisconnectedConnection.name)}
              className="flex w-full items-center gap-2 rounded-lg border border-dashed border-[#2a2a2e] px-4 py-3 text-[12px] text-[#555] transition-colors duration-150 hover:text-emerald-400 hover:border-emerald-400/30"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-[#2a2a2e] text-[11px]">+</span>
              Connect a service
            </button>
          ) : null}
        </div>
      </div>
    </main>
  );

  const detailPane =
    createOpen && !selectedConnection ? (
      <CreateJigPane
        initialInstruction={createInstruction}
        startToken={createStartToken}
        onClose={() => {
          setCreateOpen(false);
          setCreateResumeSessionId(null);
        }}
        onConnectionClick={(name) => {
          setView("connections");
          setSelectedConnection(name);
        }}
        onCreated={async (jigId) => {
          await refreshJigs(jigId);
        }}
      />
    ) : selectedJig && currentJig?.underConstruction && !selectedConnection ? (
      <CreateJigPane
        key={currentJig.underConstruction.sessionId}
        resumeSessionId={createResumeSessionId ?? currentJig.underConstruction.sessionId}
        onClose={closeDetail}
        onConnectionClick={(name) => {
          setView("connections");
          setSelectedConnection(name);
        }}
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
    <>
    <ConfirmDialog
      open={draftToDiscard !== null}
      title="Discard draft?"
      message={draftToDiscard ? `This will remove ${draftToDiscard.name} from under construction.` : "This will remove the under-construction jig."}
      confirmLabel="Discard Draft"
      destructive
      loading={discardingDraft}
      onConfirm={confirmDiscardUnderConstruction}
      onClose={() => !discardingDraft && setDraftToDiscard(null)}
    />

    {modelUpgrades.length > 0 && (
      <ModelUpgradeModal
        suggestions={modelUpgrades}
        onClose={() => setModelUpgrades([])}
      />
    )}

    <div className="flex h-full" style={{ background: "#0a0a0b" }}>
      <nav className={`flex shrink-0 flex-col border-r border-[#1f1f23] bg-[#0a0a0b] transition-all duration-200 overflow-hidden ${collapsed ? "w-[52px]" : "w-[180px]"}`}>
        <div className={`flex h-11 shrink-0 items-center border-b border-[#1f1f23] ${collapsed ? "justify-center px-0" : "justify-between px-3"}`}>
          {!collapsed ? (
            <div className="flex items-center gap-2">
              <span className="h-[7px] w-[7px] rounded-full bg-emerald-400 shrink-0" />
              <span className="text-[13px] font-semibold text-[#ededed]">Jig</span>
              <span
                className="mt-px rounded-sm bg-[#111113] px-1.5 py-0.5 text-[8px] font-mono tracking-[0.12em] text-[#555]"
                title={`Version ${APP_VERSION}`}
              >
                v{APP_VERSION}
              </span>
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
          <NavItem icon={NavIcons.jigs} label="Jigs" href="/" active={!view || view === "jigs"} collapsed={collapsed} onActivate={() => { setView(null); closeDetail(); }} />
          <NavItem icon={NavIcons.connections} label="Connections" href="/?view=connections" active={view === "connections"} collapsed={collapsed} onActivate={() => { setView("connections"); closeDetail(); }} />
          <NavItem icon={NavIcons.settings} label="Settings" href="/?view=settings" active={view === "settings"} collapsed={collapsed} onActivate={() => { setView("settings"); closeDetail(); }} />
          <NavItem icon={NavIcons.logs} label="Logs" href="/?view=logs" active={view === "logs"} collapsed={collapsed} onActivate={() => { setView("logs"); closeDetail(); }} />
        </div>

        {!collapsed && credits && (
          <button
            onClick={() => { setView("settings"); setSettingsTab("models"); setSettingsFocus("main"); closeDetail(); }}
            className="group block w-full border-t border-[#1f1f23] px-3 py-2 text-left transition-colors hover:bg-[#111113]"
            title={`OpenRouter: $${credits.remaining.toFixed(2)} of $${credits.totalCredits.toFixed(2)} remaining — manage models & key`}
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[9px] text-[#444] uppercase tracking-wider">OpenRouter</span>
              <span className="text-[9px] text-[#444] group-hover:text-[#9a9aa3]">Manage</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-mono text-[13px] text-[#ededed]">${credits.remaining.toFixed(2)}</span>
              <span className="text-[9px] text-[#555]">left</span>
            </div>
            {credits.totalCredits > 0 && (
              <>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#1a1a1d]">
                  <div
                    className={`h-full rounded-full ${credits.remaining / credits.totalCredits < 0.1 ? "bg-rose-400" : credits.remaining / credits.totalCredits < 0.25 ? "bg-amber-400" : "bg-emerald-400/70"}`}
                    style={{ width: `${Math.max(2, Math.min(100, (credits.remaining / credits.totalCredits) * 100))}%` }}
                  />
                </div>
                <div className="mt-1 text-[9px] text-[#555]">
                  ${credits.totalUsage.toFixed(2)} used of ${credits.totalCredits.toFixed(2)}
                </div>
              </>
            )}
          </button>
        )}
        {!collapsed && !credits && models && (
          <div className="border-t border-[#1f1f23] px-2 py-2">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[9px] text-[#444] uppercase tracking-wider">Models</span>
              <button
                onClick={() => { setView("settings"); setSettingsTab("models"); setSettingsFocus("main"); closeDetail(); }}
                className="text-[9px] text-[#444] hover:text-[#9a9aa3]"
              >
                Change
              </button>
            </div>
          </div>
        )}
        {collapsed && (
          <button
            onClick={() => { setView("settings"); setSettingsTab("models"); setSettingsFocus("main"); closeDetail(); }}
            className="border-t border-[#1f1f23] py-2 flex flex-col items-center gap-1 text-[#444] hover:text-[#9a9aa3] hover:bg-[#111113]"
            title="Models"
          >
            <span className="text-[9px]">AI</span>
          </button>
        )}

      </nav>

      <div className="flex flex-1 overflow-hidden">
        {view === "connections" && (
          selectedConnection && detailPane ? (
            <ResizablePanelGroup direction="horizontal" className="flex-1">
              <ResizablePanel defaultSize="52%" minSize="34%">
                {connectionsMain}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize="48%" minSize="34%" maxSize="66%">
                {detailPane}
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            connectionsMain
          )
        )}

        {view === "settings" && (() => {
          const tab: "models" | "system" | "notifications" | "danger" =
            settingsTab === "system" || settingsTab === "notifications" || settingsTab === "danger" ? settingsTab : "models";
          return (
            <main className="flex flex-col flex-1 overflow-hidden">
              <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-4">
                <span className="text-[13px] font-medium text-[#ededed]">Settings</span>
              </div>
              <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[#1f1f23] px-4">
                {(
                  [
                    ["models", "Models"],
                    ["system", "System"],
                    ["notifications", "Notifications"],
                    ["danger", "Danger"],
                  ] as const
                ).map(([key, label]) => {
                  const active = tab === key;
                  return (
                    <button
                      key={key}
                      onClick={() => {
                        setSettingsTab(key);
                        if (key !== "models") setSettingsFocus(null);
                      }}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        active
                          ? key === "danger"
                            ? "bg-rose-500/[0.08] text-rose-200"
                            : "bg-[#1a1a1d] text-[#ededed]"
                          : key === "danger"
                          ? "text-rose-300/60 hover:text-rose-200 hover:bg-rose-500/[0.05]"
                          : "text-[#666] hover:text-[#9a9aa3] hover:bg-[#111113]"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="flex-1 overflow-y-auto px-6 py-6">
                <div className="max-w-4xl mx-auto">
                  {tab === "models" && (
                    <ModelsSettings
                      autofocusSlot={
                        settingsFocus === "main" || settingsFocus === "editor" || settingsFocus === "fast"
                          ? settingsFocus
                          : undefined
                      }
                    />
	                  )}
                  {tab === "system" && <SystemSettings />}
                  {tab === "notifications" && <NotificationsSettings />}
                  {tab === "danger" && (
                    <DangerSettings
                      onReset={async () => {
                        closeDetail();
                        setView(null);
                        await mutate("jigs", [], false);
                        await mutate("examples");
                        await mutate("connections");
                      }}
                    />
                  )}
                </div>
              </div>
            </main>
          );
        })()}

        {view === "logs" && (
          <main className="flex flex-col flex-1 overflow-hidden">
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-4">
              <div className="flex flex-col">
                <span className="text-[13px] font-medium text-[#ededed]">Server Logs</span>
                <span className="text-[10px] text-[#666]">Live <code className="text-[#9a9aa3]">console.log/warn/error</code> from the Bun API server — useful for debugging a remote deploy.</span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="max-w-4xl mx-auto">
                <LogsSettings />
              </div>
            </div>
          </main>
        )}

        {(!view || view === "jigs") && (
          hasDetail && detailPane ? (
            // When creating / drafting / editing / reviewing a jig (i.e. a
            // jig-scoped detail pane, not a connection pane), give it the
            // full content area — the jig list isn't needed while focused on
            // a single jig and the close button takes you back. Connection
            // panes keep the split so the list stays reachable.
            selectedConnection ? (
              <ResizablePanelGroup direction="horizontal" className="flex-1">
                <ResizablePanel defaultSize="52%" minSize="34%">
                  {jigsPane}
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel defaultSize="48%" minSize="34%" maxSize="66%">
                  {detailPane}
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              <div className="flex-1 overflow-hidden">{detailPane}</div>
            )
          ) : (
            jigsPane
          )
        )}
      </div>
    </div>
    </>
  );
}

function NavItem({ icon, label, href, active, collapsed, onActivate }: { icon: React.ReactNode; label: string; href: string; active?: boolean; collapsed: boolean; onActivate?: () => void }) {
  // Render as <a> so middle-click / cmd-click / right-click "Open in new tab"
  // work natively. A plain click is intercepted to avoid a full page reload
  // — we update view state via nuqs instead.
  function handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return; // only intercept primary button
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onActivate?.();
  }
  return (
    <a
      href={href}
      onClick={handleClick}
      className={`flex items-center gap-2.5 rounded-md py-1.5 text-[12px] no-underline transition-colors duration-150 ${collapsed ? "justify-center mx-1 px-0" : "mx-2 px-2.5"} ${active ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#666] hover:text-[#999] hover:bg-[#111113]"}`}
    >
      <span className="shrink-0 [&>svg]:w-[14px] [&>svg]:h-[14px]">{icon}</span>
      {!collapsed && <span>{label}</span>}
    </a>
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
  logs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="14" y2="12" />
      <line x1="4" y1="17" x2="18" y2="17" />
    </svg>
  ),
};

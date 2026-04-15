import { useState } from "react";
import type { Connection, ExampleJig } from "@shared/api";
import { Button } from "@/components/button";
import { ServiceIcon } from "@/components/service-icon";
import { ConnectionTag } from "@/components/connection-tag";
import { RunSteps } from "@/components/run-steps";
import { Notice } from "@/components/state-panel";

const FEATURED_CONNECTIONS = [
  "workspace",
  "granola",
  "apify",
  "composio",
  "gmail",
  "calendar",
  "drive",
];

function pickConnectionCards(connections: Connection[]) {
  const byName = new Map(connections.map((connection) => [connection.name.toLowerCase(), connection]));
  const featured = FEATURED_CONNECTIONS
    .map((name) => byName.get(name))
    .filter((connection): connection is Connection => !!connection);

  if (featured.length > 0) return featured.slice(0, 5);
  return connections.slice(0, 5);
}

function prettifyConnectionName(name: string): string {
  return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatExampleActionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Unknown API route") {
    return "The running Jig API is older than this dashboard build. Restart `jig start` and try adding the example again.";
  }
  return message || "Failed to add example jig.";
}

export function OnboardingView({
  onCreate,
  onConnectionClick,
  onExampleAdd,
  onExampleOpen,
  connectedCount = 0,
  connections = [],
  examples = [],
  existingJigIds = [],
  examplesErrorMessage,
}: {
  onCreate?: () => void;
  onConnectionClick?: (name: string) => void;
  onExampleAdd?: (id: string) => Promise<void> | void;
  onExampleOpen?: (id: string) => void;
  connectedCount?: number;
  connections?: Connection[];
  examples?: ExampleJig[];
  existingJigIds?: string[];
  examplesErrorMessage?: string;
}) {
  const [expandedExampleId, setExpandedExampleId] = useState<string | null>(null);
  const [addingExampleId, setAddingExampleId] = useState<string | null>(null);
  const [exampleStatus, setExampleStatus] = useState<string | null>(null);
  const cards = pickConnectionCards(connections);
  const existing = new Set(existingJigIds);

  return (
    <div className="mx-auto max-w-xl space-y-6 pt-8" style={{ animation: "fade-up 0.3s ease" }}>
      <div className="text-center">
        <h2 className="text-[15px] font-semibold text-[#ededed]">Welcome to Jig</h2>
        <p className="mt-1 text-[11px] text-[#555]">0 jigs &middot; {connectedCount} connections</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cards.map((connection) => (
          <button
            key={connection.name}
            onClick={() => onConnectionClick?.(connection.name)}
            className={`group flex items-center gap-3 rounded-lg border p-3.5 text-left transition-colors duration-150 ${
              connection.connected
                ? "border-emerald-500/20 bg-emerald-500/[0.04] hover:border-emerald-500/30 hover:bg-emerald-500/[0.06]"
                : "border-[#1f1f23] bg-[#111113] hover:border-[#2a2a2e] hover:bg-[#151517]"
            }`}
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#1a1a1d]">
              <ServiceIcon name={connection.name} size={20} />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-[13px] font-medium text-[#ededed]">
                  {connection.connected ? prettifyConnectionName(connection.name) : `Connect ${prettifyConnectionName(connection.name)}`}
                </p>
              </div>
              <p className="text-[11px] text-[#555] mt-0.5">{connection.description || "Connect this service to make its tools available in Jig."}</p>
            </div>
          </button>
        ))}
        <button
          onClick={onCreate}
          className="group flex items-center gap-3 rounded-lg border border-dashed border-[#2a2a2e] bg-transparent p-3.5 text-left transition-colors duration-150 hover:border-emerald-500/30 hover:bg-emerald-500/[0.03]"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-500/10 text-sm text-emerald-400">&#10024;</span>
          <div>
            <p className="text-[13px] font-medium text-[#ededed]">Create your first jig</p>
            <p className="text-[11px] text-[#555]">Describe a task, we&apos;ll automate it</p>
          </div>
        </button>
      </div>
      {examples.length > 0 && (
        <div className="space-y-3">
          <div className="text-center">
            <h3 className="text-[12px] font-medium uppercase tracking-wider text-[#888]">Example Jigs</h3>
            <p className="mt-1 text-[11px] text-[#555]">These live in the repo&apos;s <code className="text-[#888]">examples/</code> directory, so reset leaves them intact.</p>
          </div>
          {examplesErrorMessage ? (
            <Notice tone="warning" title="Couldn’t load examples">
              {examplesErrorMessage}
            </Notice>
          ) : null}
          {exampleStatus && (
            <Notice tone={exampleStatus.startsWith("Added ") ? "success" : "warning"}>
              {exampleStatus}
            </Notice>
          )}
          <div className="space-y-3">
            {examples.map((example) => {
              const expanded = expandedExampleId === example.id;
              const exists = existing.has(example.id);
              const adding = addingExampleId === example.id;
              return (
                <div
                  key={example.id}
                  className="rounded-lg border border-[#1f1f23] bg-[#111113] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-[#ededed]">{example.name}</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-[#666]">{example.description}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="rounded-full border border-[#1f1f23] bg-[#0d0d0f] px-2 py-0.5 text-[10px] font-mono text-[#888]">
                          {example.trigger}
                        </span>
                        {example.connections.map((connection) => (
                          <ConnectionTag key={`${example.id}:${connection}`} name={connection} />
                        ))}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      <Button
                        onClick={() => {
                          setExpandedExampleId(expanded ? null : example.id);
                        }}
                        variant="subtle"
                        size="sm"
                      >
                        {expanded ? "Hide Steps" : "View Steps"}
                      </Button>
                      <Button
                        onClick={async () => {
                          setExampleStatus(null);
                          if (exists) {
                            onExampleOpen?.(example.id);
                            return;
                          }
                          try {
                            setAddingExampleId(example.id);
                            await onExampleAdd?.(example.id);
                            setExampleStatus(`Added ${example.name}.`);
                          } catch (error: unknown) {
                            setExampleStatus(formatExampleActionError(error));
                          } finally {
                            setAddingExampleId(null);
                          }
                        }}
                        disabled={adding}
                        variant={exists ? "subtle" : "successOutline"}
                        size="sm"
                      >
                        {adding ? "Adding…" : exists ? "Open" : "Add Example"}
                      </Button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="mt-3">
                      <RunSteps
                        steps={example.steps}
                        mode={{ type: "idle" }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

import type { Connection, ExampleJig } from "@shared/api";
import { CopyButton } from "@/components/copy-button";
import { ServiceIcon } from "@/components/service-icon";
import { ConnectionTag } from "@/components/connection-tag";
import { Notice } from "@/components/state-panel";
import { isRecommendedConnection, sortConnectionsForDisplay } from "@/lib/connection-catalog";

function pickConnectionCards(connections: Connection[]) {
  return sortConnectionsForDisplay(connections).slice(0, 5);
}

function prettifyConnectionName(name: string): string {
  return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function OnboardingView({
  onConnectionClick,
  connectedCount = 0,
  connections = [],
  examples = [],
  examplesErrorMessage,
}: {
  onConnectionClick?: (name: string) => void;
  connectedCount?: number;
  connections?: Connection[];
  examples?: ExampleJig[];
  examplesErrorMessage?: string;
}) {
  const cards = pickConnectionCards(connections);

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
                {isRecommendedConnection(connection.name) && (
                  <span className="rounded-full border border-emerald-500/20 bg-emerald-500/[0.08] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-emerald-300">
                    recommended
                  </span>
                )}
              </div>
              <p className="text-[11px] text-[#555] mt-0.5">{connection.description || "Connect this service to make its tools available in Jig."}</p>
            </div>
          </button>
        ))}
      </div>
      {examples.length > 0 && (
        <div className="space-y-3">
          <div className="text-center">
            <h3 className="text-[12px] font-medium uppercase tracking-wider text-[#888]">Example Jigs</h3>
            <p className="mt-1 text-[11px] text-[#555]">Starter prompts for your coding agent. Copy one into Claude Code or Codex in your paired checkout.</p>
          </div>
          {examplesErrorMessage ? (
            <Notice tone="warning" title="Couldn’t load examples">
              {examplesErrorMessage}
            </Notice>
          ) : null}
          <div className="space-y-3">
            {examples.map((example) => (
              <div key={example.id} className="rounded-lg border border-[#1f1f23] bg-[#111113] p-4">
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
                  <CopyButton
                    className="shrink-0"
                    text={example.prompt}
                    label="Copy prompt"
                    toast="Prompt copied. Paste it into Claude Code or Codex in your paired checkout."
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

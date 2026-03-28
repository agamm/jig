"use client";

import { useState } from "react";
import type { Jig } from "@/types/jig";
import { ConnectionTag } from "@/components/connection-tag";
import { HighlightedCode } from "@/components/highlighted-code";
import { StepList } from "@/components/step-list";
import { TRIGGER_SUGGESTIONS } from "@/mock/mock-data";
import { useTriggerSave } from "@/hooks/use-trigger-save";

export function ReviewPane({ jig, onClose, isEditing = false }: {
  jig: Jig;
  onClose: () => void;
  isEditing?: boolean;
}) {
  const [detailTab, setDetailTab] = useState<"steps" | "code">("steps");
  const trigger = useTriggerSave(jig.id, jig.settings.trigger);
  const [editInput, setEditInput] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  return (
    <aside
      className="flex w-[48%] shrink-0 flex-col border-l border-amber-500/30 bg-[#0e0e10] overflow-hidden"
      style={{ animation: "slide-in-right 0.2s ease" }}
    >
      {/* Construction stripe banner */}
      <div className="construction-stripe border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
        <span className="text-amber-400 text-[11px]">&#9888;</span>
        <span className="text-[11px] text-amber-400 font-medium">{isEditing ? `Editing — ${jig.name}` : "Draft \u2014 not compiled yet"}</span>
        <span className="text-[10px] text-amber-400/50 ml-auto">Edit steps below, then compile</span>
      </div>

      {/* Header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-4 gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-[#ededed] whitespace-nowrap">{jig.name}</h2>
          <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-400">draft</span>
        </div>
        <button
          onClick={onClose}
          className="rounded-md border border-[#1f1f23] bg-[#111113] px-2 py-1 text-[11px] text-[#555] transition-colors duration-150 hover:text-[#888] hover:bg-[#1a1a1d]"
        >
          &#10005;
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* Steps / Code toggle */}
        <div className="flex gap-0.5 rounded-lg border border-[#1f1f23] bg-[#0a0a0b] p-0.5 w-fit">
          <button onClick={() => setDetailTab("steps")} className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors duration-150 ${detailTab === "steps" ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`}>Steps</button>
          <button onClick={() => setDetailTab("code")} className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors duration-150 ${detailTab === "code" ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`}>Code</button>
        </div>

        {/* Steps or Code */}
        {detailTab === "steps" ? (
          <div key="steps" className="flip-enter">
            <StepList steps={jig.steps} editable />
          </div>
        ) : (
          <div key="code" className="rounded-lg border border-[#1f1f23] bg-[#111113] p-4 font-mono overflow-x-auto flip-enter">
            <HighlightedCode code={jig.code} connections={jig.settings.connections} />
          </div>
        )}

        {/* Trigger */}
        <div>
          <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Trigger</h3>
          {trigger.editing ? (
            <div className="rounded-lg border border-blue-500/30 bg-[#111113] p-3 space-y-2" style={{ animation: "fade-up 0.15s ease" }}>
              <input
                type="text"
                value={trigger.value}
                onChange={(e) => trigger.setValue(e.target.value)}
                className="w-full rounded-md border border-[#1f1f23] bg-[#0a0a0b] px-3 py-1.5 text-[12px] text-[#ededed] outline-none focus:border-blue-500/50 transition-colors duration-150"
                autoFocus
              />
              <p className="text-[10px] text-[#555]">Type naturally, e.g. &quot;every friday at 9am&quot;</p>
              <div className="flex flex-wrap gap-1.5">
                {TRIGGER_SUGGESTIONS.map(s => (
                  <button
                    key={s}
                    onClick={() => trigger.setValue(s)}
                    className="rounded-md border border-[#1f1f23] bg-[#0a0a0b] px-2 py-1 text-[10px] text-[#888] transition-colors duration-150 hover:border-[#2a2a2e] hover:text-[#ededed]"
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5 pt-1">
                <button
                  disabled={trigger.saving}
                  onClick={trigger.save}
                  className="rounded-md bg-blue-600 px-2.5 py-1 text-[10px] font-medium text-white transition-colors duration-150 hover:bg-blue-500 disabled:opacity-50"
                >{trigger.saving ? "Saving…" : "Save"}</button>
                <button onClick={trigger.cancel} className="rounded-md border border-[#1f1f23] px-2.5 py-1 text-[10px] text-[#555] transition-colors duration-150 hover:text-[#888]">Cancel</button>
              </div>
            </div>
          ) : (
            <button
              onClick={trigger.startEditing}
              className="group inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-left"
            >
              <span className="text-[12px] font-mono text-[#ccc] decoration-dotted underline-offset-4 group-hover:underline group-hover:decoration-[#555]">{trigger.display}</span>
              <span className="text-[10px] text-[#333] opacity-0 group-hover:opacity-100 transition-opacity duration-150">&#9998;</span>
            </button>
          )}
        </div>

        {/* Edit with AI */}
        <div className="space-y-3">
          <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider">Edit</h3>
          <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.03] p-3 space-y-2">
            <div className="flex gap-1.5">
              <input
                type="text"
                placeholder="Describe a change... e.g. 'add a step to cc my manager'"
                value={editInput}
                onChange={(e) => setEditInput(e.target.value)}
                className="flex-1 rounded-md border border-[#1f1f23] bg-[#0a0a0b] px-3 py-1.5 text-[11px] text-[#ededed] placeholder:text-[#444] outline-none transition-colors duration-150 focus:border-violet-500/30"
              />
              <button
                onClick={async () => {
                  if (!editInput.trim()) return;
                  setEditError(null);
                  try {
                    const res = await fetch(`/api/jigs/${encodeURIComponent(jig.id)}/edit`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ instruction: editInput }),
                    });
                    if (res.status === 409) { setEditError("Edit already in progress"); return; }
                    if (!res.ok) { setEditError("Failed to start edit"); return; }
                    const { editId: id } = await res.json();
                    setEditId(id);
                    setEditStatus("planning");

                    // Poll for completion
                    for (let i = 0; i < 120; i++) {
                      await new Promise(r => setTimeout(r, 1000));
                      const poll = await fetch(`/api/jigs/${encodeURIComponent(jig.id)}/edit-status?editId=${id}`);
                      if (!poll.ok) continue;
                      const data = await poll.json();
                      setEditStatus(data.status);
                      if (data.status === "done") { setEditId(null); window.location.reload(); return; }
                      if (data.status === "error") { setEditError(data.message ?? "Edit failed"); setEditId(null); return; }
                    }
                    setEditError("Timed out");
                    setEditId(null);
                  } catch (e: any) {
                    setEditError(e?.message ?? "Unknown error");
                  }
                }}
                disabled={!!editId || !editInput.trim()}
                className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white transition-all duration-150 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editId ? "Applying\u2026" : "Apply"}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {["Add a CC recipient", "Change trigger to weekly", "Add error handling", "Require approval before send"].map(s => (
                <button key={s} className="rounded-full border border-[#1f1f23] bg-[#0a0a0b] px-2 py-0.5 text-[9px] text-[#555] hover:text-[#888] hover:border-[#2a2a2e] transition-colors cursor-pointer">
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-[#444]">
            {(["planning", "selecting-tools", "probing", "generating", "validating", "dry-running"] as const).map((stage, i) => {
              const labels: Record<string, string> = { "planning": "Plan", "selecting-tools": "Select tools", "probing": "Probe", "generating": "Generate", "validating": "Validate", "dry-running": "Dry run" };
              const stages = ["planning", "selecting-tools", "probing", "generating", "validating", "dry-running", "done"];
              const active = editStatus === stage;
              const done = editStatus !== null && stages.indexOf(editStatus) > i;
              return (
                <span key={stage} className="flex items-center gap-1">
                  {i > 0 && <span className="text-[#333] mr-1">&rarr;</span>}
                  <span className={`h-1.5 w-1.5 rounded-full transition-colors ${active ? "bg-blue-400 animate-pulse" : done ? "bg-emerald-400" : "bg-[#333]"}`} />
                  {labels[stage]}
                </span>
              );
            })}
          </div>
          {editError && (
            <p className="text-[10px] text-rose-400 mt-1">{editError}</p>
          )}
        </div>

        {/* Connections */}
        <div>
          <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Connections</h3>
          <div className="flex flex-wrap gap-1.5">
            {jig.settings.connections.map(c => (
              <ConnectionTag key={c} name={c} />
            ))}
            <button className="inline-flex items-center gap-1 rounded-full border border-dashed border-[#2a2a2e] px-2 py-0.5 text-[10px] text-[#444] hover:text-[#888] hover:border-[#444] transition-colors cursor-pointer">
              + Add
            </button>
          </div>
        </div>

        {/* Compile & Save / Done */}
        {isEditing ? (
          <div className="flex gap-2 pt-2">
            <button onClick={onClose} className="flex-1 rounded-md bg-emerald-600 py-2 text-[12px] font-medium text-white transition-all duration-150 hover:bg-emerald-500 active:scale-95">Done</button>
          </div>
        ) : (
          <div className="pt-2">
            <button
              disabled={!trigger.value}
              title={!trigger.value ? "Set a trigger first" : ""}
              className="w-full rounded-md bg-gradient-to-r from-emerald-600 to-emerald-500 py-2 text-[12px] font-semibold text-white shadow-lg shadow-emerald-600/20 transition-all duration-200 hover:shadow-emerald-600/30 hover:brightness-110 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ animation: "shimmer 3s infinite" }}
            >
              Compile &amp; Save
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

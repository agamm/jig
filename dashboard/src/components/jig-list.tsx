"use client";

import { useState } from "react";
import type { Jig } from "@/types/jig";
import { ServiceIcon } from "@/components/service-icon";
import { Sparkline } from "@/components/sparkline";
import { useDragReorder } from "@/hooks/use-drag-reorder";

const statusColor = (s: string) =>
  s === "healthy" ? "#34d399" : s === "attention" ? "#f59e0b" : "#f43f5e";

const statusDot = (s: string) =>
  s === "healthy" ? "bg-emerald-400" : s === "attention" ? "bg-amber-400" : "bg-rose-400";

export function JigList({ jigs, selectedJigId, onJigClick, onReorder, onCreate }: {
  jigs: Jig[];
  selectedJigId: string | null;
  onJigClick: (jig: Jig) => void;
  onReorder: (newJigs: Jig[]) => void;
  onCreate: () => void;
}) {
  const [jigSearch, setJigSearch] = useState("");
  const { draggingIdx, dropTargetIdx, dropSide, getDragProps, handleDrop } = useDragReorder<Jig>();

  const filteredJigs = jigSearch
    ? jigs.filter((j) => {
        const query = jigSearch.toLowerCase();
        return j.name.toLowerCase().includes(query) || (j.groupName?.toLowerCase().includes(query) ?? false);
      })
    : jigs;
  const jigIndexById = new Map(filteredJigs.map((jig, idx) => [jig.id, idx]));

  function renderJigRow(jig: Jig, idx: number) {
    const isSelected = selectedJigId === jig.id;
    const isDragging = draggingIdx === idx;
    const isDropTarget = dropTargetIdx === idx;
    const dragProps = getDragProps(idx);

    return (
      <div key={jig.id} className="relative">
        {isDropTarget && dropSide === "above" && (
          <div className="absolute -top-[1px] left-3 right-3 h-[2px] bg-blue-500 rounded-full z-10" />
        )}
        <div
          {...dragProps}
          onDrop={(e: React.DragEvent) => {
            e.preventDefault();
            handleDrop(idx, jigs, onReorder);
          }}
          onClick={() => onJigClick(jig)}
          className={`group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all duration-150 cursor-pointer select-none
            ${isSelected ? "bg-[#1a1a1d]" : "hover:bg-[#111113]"}
            ${isDragging ? "opacity-40 shadow-lg" : ""}
          `}
        >
          <span
            className="text-[12px] text-[#333] opacity-0 group-hover:opacity-100 transition-opacity duration-150 cursor-grab active:cursor-grabbing select-none shrink-0"
            title="Drag to reorder"
          >
            &#x2807;
          </span>

          {jig.running ? (
            <span className="relative h-[7px] w-[7px] shrink-0">
              <span className="absolute inset-0 rounded-full bg-blue-400/30 animate-ping" />
              <span className="absolute inset-0 rounded-full bg-blue-400" />
            </span>
          ) : (
            <span className={`h-[7px] w-[7px] rounded-full shrink-0 ${statusDot(jig.status)}`} />
          )}

          <span className={`flex min-w-0 items-baseline gap-1.5 text-[13px] font-medium ${isSelected ? "text-[#ededed]" : "text-[#ccc]"}`}>
            {jig.groupName && (
              <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-[#5a5a61]">
                {jig.groupName}
              </span>
            )}
            {jig.groupName && <span className="shrink-0 text-[#4b4b51]">/</span>}
            <span className="truncate">{jig.name}</span>
          </span>

          <span className="flex shrink-0 -space-x-1.5 hover:-space-x-0.5 transition-all duration-500 ease-out">
            {jig.settings.connections.slice(0, 3).map((c, ci) => (
              <span key={c} className="inline-block rounded-full bg-[#111113] border border-[#1f1f23] p-0.5 transition-all duration-500 ease-out" style={{ zIndex: 3 - ci }}>
                <ServiceIcon name={c} size={12} />
              </span>
            ))}
          </span>

          <span className="rounded-md bg-[#111113] border border-[#1f1f23] px-2 py-0.5 font-mono text-[10px] text-[#888] shrink-0">
            {jig.trigger}
          </span>

          <span className="flex-1" />

          <Sparkline data={jig.sparkline} color={statusColor(jig.status)} />
          {jig.costMonth && (
            <span className="group/cost relative text-[10px] text-[#444] font-mono shrink-0 cursor-default">
              {jig.costMonth}/mo
              {jig.costLifetime && (
                <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover/cost:flex flex-col items-center rounded-md bg-[#1a1a1d] border border-[#2a2a2e] px-2.5 py-1.5 shadow-lg whitespace-nowrap z-50" style={{ animation: "fade-up 0.1s ease" }}>
                  <span className="text-[10px] text-[#888]">Lifetime</span>
                  <span className="text-[11px] text-[#ededed] font-medium">{jig.costLifetime}</span>
                  <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 bg-[#1a1a1d] border-r border-b border-[#2a2a2e]" />
                </span>
              )}
            </span>
          )}

          <span className="w-3 shrink-0" />
        </div>

        {isDropTarget && dropSide === "below" && (
          <div className="absolute -bottom-[1px] left-3 right-3 h-[2px] bg-blue-500 rounded-full z-10" />
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl" style={{ animation: "fade-up 0.3s ease" }}>
      {/* Jig filters + search inline */}
      <div className="flex items-center gap-1.5 mb-3">
        <div className="flex gap-1">
          {["All", "Active", "Failed", "Scheduled"].map(f => (
            <span key={f} className={`rounded-full px-2.5 py-0.5 text-[11px] cursor-pointer transition-colors duration-150 ${f === "All" ? "bg-[#1a1a1d] text-[#ededed]" : "text-[#555] hover:text-[#888]"}`}>
              {f}
            </span>
          ))}
        </div>
        <span className="text-[10px] text-[#333]">&middot;</span>
        <span className="text-[11px] text-[#444]">{filteredJigs.length} jigs</span>
        <div className="ml-auto relative w-36">
        <svg className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[#333]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input
          type="text"
          value={jigSearch}
          onChange={(e) => setJigSearch(e.target.value)}
          placeholder="Filter..."
          className="w-full rounded-md border-0 bg-transparent pl-7 pr-2 py-0.5 text-[11px] text-[#888] placeholder:text-[#333] outline-none transition-colors duration-150 focus:bg-[#111113] focus:text-[#ededed]"
        />
        </div>
      </div>

      {/* Jig list rows */}
      <div className="space-y-0.5">
        {filteredJigs.map((jig) => renderJigRow(jig, jigIndexById.get(jig.id) ?? 0))}

        {filteredJigs.length === 0 && (
          <div className="text-center py-8 text-[#444] text-[12px]">
            No jigs match your filter
          </div>
        )}

        {/* + New Jig row */}
        <button
          onClick={onCreate}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors duration-150 text-[#444] hover:text-emerald-400 hover:bg-[#111113] mt-1"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-[#2a2a2e] text-[11px]">+</span>
          <span className="text-[12px]">New Jig</span>
        </button>
      </div>
    </div>
  );
}

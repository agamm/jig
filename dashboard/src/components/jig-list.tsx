"use client";

import { useState } from "react";
import type { Jig } from "@/types/jig";
import { ServiceIcon } from "@/components/service-icon";
import { ConnectionTag } from "@/components/connection-tag";
import { Sparkline } from "@/components/sparkline";
import { useDragReorder } from "@/hooks/use-drag-reorder";

const statusColor = (s: string) =>
  s === "healthy" ? "#34d399" : s === "attention" ? "#f59e0b" : "#f43f5e";

const statusDot = (s: string) =>
  s === "healthy" ? "bg-emerald-400" : s === "attention" ? "bg-amber-400" : "bg-rose-400";

export function JigList({ jigs, selectedJigId, expandedGroup, onJigClick, onEntityClick, onReorder, onExpandGroup, onApprovalClick, phase }: {
  jigs: Jig[];
  selectedJigId: string | null;
  expandedGroup: string | null;
  onJigClick: (jig: Jig) => void;
  onEntityClick: (entityName: string) => void;
  onReorder: (newJigs: Jig[]) => void;
  onExpandGroup: (jigId: string | null) => void;
  onApprovalClick: (approvalId: string) => void;
  phase: string;
}) {
  const [jigSearch, setJigSearch] = useState("");
  const { draggingIdx, dropTargetIdx, dropSide, getDragProps, handleDrop } = useDragReorder<Jig>();

  const filteredJigs = jigSearch ? jigs.filter(j => j.name.toLowerCase().includes(jigSearch.toLowerCase())) : jigs;

  return (
    <div className="mx-auto max-w-3xl" style={{ animation: "fade-up 0.3s ease" }}>
      {/* Needs Attention — 3D stacked cards */}
      {phase === "week2" && (
        <div className="mb-5 relative cursor-pointer pb-2" onClick={() => {
          onApprovalClick("invoice-acme");
        }}>
          {/* Card 3 (back — peeks below) */}
          <div className="absolute inset-x-4 bottom-0 h-14 rounded-lg border border-amber-500/8 bg-amber-500/[0.02]" />
          {/* Card 2 (middle — peeks below) */}
          <div className="absolute inset-x-2 bottom-1 h-14 rounded-lg border border-amber-500/12 bg-amber-500/[0.03]" />
          {/* Card 1 (front) */}
          <div className="relative rounded-lg border border-amber-500/20 bg-[#111113] p-3.5 transition-all duration-150 hover:border-amber-500/30 hover:bg-[#141416]">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-[12px] font-medium text-amber-400">3 pending approvals</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <p className="text-[13px] text-[#ededed]">Invoice &mdash; Acme: Send invoice email</p>
                <span className="text-[13px] font-medium text-[#ededed]">$25,200</span>
                <ConnectionTag name="Gmail" />
              </div>
              <button onClick={(e) => { e.stopPropagation(); onApprovalClick("invoice-acme"); }} className="shrink-0 rounded-md border border-[#1f1f23] px-3 py-1.5 text-[11px] text-[#555] transition-colors duration-150 hover:bg-[#1a1a1d] hover:text-[#ededed]">Details &rarr;</button>
            </div>
          </div>
        </div>
      )}

      {/* Jig filters + search inline */}
      <div className="flex items-center gap-2 mb-3">
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
        {filteredJigs.map((jig, idx) => {
          const isSelected = selectedJigId === jig.id;
          const isDragging = draggingIdx === idx;
          const isDropTarget = dropTargetIdx === idx;
          const dragProps = getDragProps(idx);
          return (
            <div key={jig.id} className="relative">
              {/* Drop indicator line */}
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
                {/* Drag grip — visible on hover */}
                <span
                  className="text-[12px] text-[#333] opacity-0 group-hover:opacity-100 transition-opacity duration-150 cursor-grab active:cursor-grabbing select-none shrink-0"
                  title="Drag to reorder"
                >
                  &#x2807;
                </span>

                {/* Status dot */}
                <span className={`h-[7px] w-[7px] rounded-full shrink-0 ${statusDot(jig.status)}`} />

                {/* Name + group count */}
                <span className={`text-[13px] font-medium w-40 truncate ${isSelected ? "text-[#ededed]" : "text-[#ccc]"}`}>
                  {jig.name}
                </span>
                {jig.grouped && jig.entityCount && (
                  <span className="shrink-0 rounded-full bg-[#1a1a1d] px-1.5 py-0 text-[9px] text-[#666] tabular-nums">
                    {jig.entityCount}
                  </span>
                )}

                {/* Stacked connection icons — fan out on hover */}
                <span className="flex shrink-0 -space-x-1.5 hover:space-x-0.5 transition-all duration-200">
                  {jig.settings.connections.slice(0, 3).map((c, ci) => (
                    <span key={c} className="inline-block rounded-full bg-[#111113] border border-[#1f1f23] p-0.5 transition-transform duration-200" style={{ zIndex: 3 - ci }}>
                      <ServiceIcon name={c} size={12} />
                    </span>
                  ))}
                </span>

                {/* Trigger badge */}
                <span className="rounded-md bg-[#111113] border border-[#1f1f23] px-2 py-0.5 font-mono text-[10px] text-[#888] shrink-0">
                  {jig.trigger}
                </span>

                {/* Spacer */}
                <span className="flex-1" />

                {/* Sparkline + cost — right-aligned */}
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

                {/* Run button — only on non-grouped jigs */}
                {!jig.grouped && (
                  <button
                    onClick={(ev) => { ev.stopPropagation(); }}
                    className="shrink-0 rounded-md text-[9px] px-1.5 py-0.5 bg-[#1a1a1d] border border-[#2a2a2e] text-[#666] hover:text-emerald-400 hover:border-emerald-500/30 transition-all duration-150 cursor-pointer"
                  >
                    Run
                  </button>
                )}

                {/* Group chevron — down arrow when collapsed, up when expanded */}
                {jig.grouped ? (
                  <svg
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    className={`shrink-0 text-[#444] transition-transform duration-200 ${expandedGroup === jig.id ? "rotate-180" : ""}`}
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                ) : (
                  <span className="w-3 shrink-0" />
                )}
              </div>

              {/* Drop indicator line (below) */}
              {isDropTarget && dropSide === "below" && (
                <div className="absolute -bottom-[1px] left-3 right-3 h-[2px] bg-blue-500 rounded-full z-10" />
              )}

              {/* Expanded group entities (inline) */}
              {expandedGroup === jig.id && jig.entities && (
                <div className="ml-8 mt-1 mb-2 space-y-px" style={{ animation: "fade-up 0.2s ease" }}>
                  {jig.entities.map(e => (
                    <button
                      key={e.name}
                      onClick={(ev) => { ev.stopPropagation(); onEntityClick(e.name); }}
                      className="group/entity flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left transition-colors duration-150 hover:bg-[#111113]"
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${e.status === "success" ? "bg-emerald-400" : "bg-rose-400"}`} />
                      <span className="text-[12px] text-[#ccc]">{e.name}</span>
                      <span className="text-[10px] text-[#444]">{e.lastRun}</span>
                      <span className="flex-1" />
                      <span
                        onClick={(ev) => { ev.stopPropagation(); }}
                        className="rounded-md text-[9px] px-1.5 py-0.5 bg-[#1a1a1d] border border-[#2a2a2e] text-[#666] hover:text-emerald-400 hover:border-emerald-500/30 transition-all duration-150 cursor-pointer opacity-0 group-hover/entity:opacity-100"
                      >
                        Run
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {filteredJigs.length === 0 && (
          <div className="text-center py-8 text-[#444] text-[12px]">
            No jigs match your filter
          </div>
        )}

        {/* + New Jig row */}
        <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors duration-150 text-[#444] hover:text-emerald-400 hover:bg-[#111113] mt-1">
          <span className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-[#2a2a2e] text-[11px]">+</span>
          <span className="text-[12px]">New Jig</span>
        </button>
      </div>
    </div>
  );
}

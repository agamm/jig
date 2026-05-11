"use client";

import { useState } from "react";
import type { Jig } from "@/types/jig";
import { SegmentedControl } from "@/components/segmented-control";
import { ServiceIcon } from "@/components/service-icon";
import { Sparkline } from "@/components/sparkline";
import { EmptyState } from "@/components/state-panel";
import { TextInput } from "@/components/input";
import { useDragReorder } from "@/hooks/use-drag-reorder";

const statusColor = (s: string) =>
  s === "healthy" ? "#34d399" : s === "attention" ? "#f59e0b" : "#f43f5e";

const runStatusColor = (s: "success" | "fail") =>
  s === "success" ? "#34d399" : "#f43f5e";

function runDurationValue(duration: string): number {
  if (!duration || duration === "—") return 0;
  const hours = duration.match(/(\d+(?:\.\d+)?)h/)?.[1];
  const minutes = duration.match(/(\d+(?:\.\d+)?)m/)?.[1];
  const seconds = duration.match(/(\d+(?:\.\d+)?)s/)?.[1];
  const explicit = (Number(hours ?? 0) * 3600) + (Number(minutes ?? 0) * 60) + Number(seconds ?? 0);
  if (explicit > 0) return explicit;
  const numeric = Number.parseFloat(duration);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatNextRun(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = d.getTime() - now;
  if (diffMs < 0) return "due";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

const statusDot = (s: string) =>
  s === "healthy" ? "bg-emerald-400" : s === "attention" ? "bg-amber-400" : "bg-rose-400";

export function JigList({ jigs, selectedJigId, onJigClick, onReorder, onCreate, onDiscardUnderConstruction }: {
  jigs: Jig[];
  selectedJigId: string | null;
  onJigClick: (jig: Jig) => void;
  onReorder: (newJigs: Jig[]) => void;
  onCreate: () => void;
  onDiscardUnderConstruction?: (jig: Jig) => void;
}) {
  const [jigSearch, setJigSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "running" | "attention" | "scheduled">("all");
  const { draggingIdx, dropTargetIdx, dropSide, getDragProps, handleDrop } = useDragReorder<Jig>();

  const filteredJigs = jigs.filter((jig) => {
    const query = jigSearch.trim().toLowerCase();
    const matchesQuery = !query || jig.name.toLowerCase().includes(query);
    if (!matchesQuery) return false;

    switch (filter) {
      case "running":
        return jig.running;
      case "attention":
        return jig.status !== "healthy";
      case "scheduled":
        return !!jig.schedule?.nextRunAt;
      default:
        return true;
    }
  });
  const jigIndexById = new Map(filteredJigs.map((jig, idx) => [jig.id, idx]));

  function renderJigRow(jig: Jig, idx: number) {
    const isSelected = selectedJigId === jig.id;
    const isUnderConstruction = !!jig.underConstruction;
    const isDragging = draggingIdx === idx;
    const isDropTarget = dropTargetIdx === idx;
    const dragProps = getDragProps(idx);
    const sparklineRuns = jig.runs.slice(0, 7).reverse();
    const sparklineData = sparklineRuns.length > 0
      ? sparklineRuns.map((run) => runDurationValue(run.duration))
      : jig.sparkline;
    const sparklineColors = sparklineRuns.map((run) => runStatusColor(run.status));

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
          ) : isUnderConstruction ? (
            <span className="h-[7px] w-[7px] rounded-[2px] bg-amber-400 shrink-0 rotate-45" />
          ) : (
            <span className={`h-[7px] w-[7px] rounded-full shrink-0 ${statusDot(jig.status)}`} />
          )}

          <span className={`flex min-w-0 items-baseline gap-1.5 text-[13px] font-medium ${isSelected ? "text-[#ededed]" : "text-[#ccc]"}`}>
            <span className="truncate">{jig.name}</span>
            {isUnderConstruction && <span className="text-[9px] font-normal text-amber-400 shrink-0">Under construction</span>}
            {jig.running && <span className="text-[9px] font-normal text-blue-400 shrink-0">Running</span>}
          </span>

          <span className="flex shrink-0 -space-x-1.5 hover:-space-x-0.5 transition-all duration-500 ease-out">
            {jig.settings.connections.slice(0, 3).map((c, ci) => (
              <span key={c} className="inline-block rounded-full bg-[#111113] border border-[#1f1f23] p-0.5 transition-all duration-500 ease-out" style={{ zIndex: 3 - ci }}>
                <ServiceIcon name={c} size={12} />
              </span>
            ))}
          </span>

          <span className="rounded-md bg-[#111113] border border-[#1f1f23] px-2 py-0.5 font-mono text-[10px] text-[#888] shrink-0">
            {isUnderConstruction ? "draft" : jig.trigger}
          </span>
          {jig.schedule?.nextRunAt && (
            <span className="text-[9px] text-[#444] shrink-0" title={`Next: ${new Date(jig.schedule.nextRunAt).toLocaleString()}`}>
              {formatNextRun(jig.schedule.nextRunAt)}
            </span>
          )}

          <span className="flex-1" />

          {isUnderConstruction ? (
            <span className="construction-stripe rounded-md border border-amber-500/20 px-2 py-0.5 text-[9px] font-medium text-amber-300/80 shrink-0">
              not runnable yet
            </span>
          ) : (
            <Sparkline data={sparklineData} color={statusColor(jig.status)} colors={sparklineColors} />
          )}
          {isUnderConstruction && onDiscardUnderConstruction && (
            <button
              type="button"
              draggable={false}
              onClick={(event) => {
                event.stopPropagation();
                onDiscardUnderConstruction(jig);
              }}
              onDragStart={(event) => event.stopPropagation()}
              className="shrink-0 rounded-md border border-rose-500/15 bg-rose-500/[0.05] px-2 py-0.5 text-[9px] font-medium text-rose-200 opacity-0 transition-opacity duration-150 hover:border-rose-500/25 hover:bg-rose-500/[0.1] group-hover:opacity-100"
              title="Discard draft"
              aria-label={`Discard ${jig.name}`}
            >
              Discard
            </button>
          )}
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
      <div className="mb-3 flex items-center gap-3">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "running", label: "Running" },
            { value: "attention", label: "Attention" },
            { value: "scheduled", label: "Scheduled" },
          ]}
        />
        <span className="text-[11px] text-[var(--text-dim)]">{filteredJigs.length} jigs</span>
        <TextInput
          className="ml-auto w-44"
          inputClassName="py-1 pl-8 pr-2 text-[11px]"
          type="text"
          value={jigSearch}
          onChange={(e) => setJigSearch(e.target.value)}
          placeholder="Search jigs…"
          leading={
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
          }
        />
      </div>

      <div className="space-y-0.5">
        {filteredJigs.map((jig) => renderJigRow(jig, jigIndexById.get(jig.id) ?? 0))}

        {filteredJigs.length === 0 && (
          <EmptyState
            title="No jigs match this view"
            description={jigSearch ? "Try a different search or filter." : "Change the filter or create a new jig."}
          />
        )}

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

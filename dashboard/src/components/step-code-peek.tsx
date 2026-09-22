"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JigStepTool } from "@shared/api";
import { highlightTypeScript } from "@/lib/syntax-highlight";
import { ServiceIcon } from "@/components/service-icon";
import { describeTool, serviceName } from "@/lib/step-labels";

const highlighted = new Map<string, Promise<string>>();
function highlightOnce(code: string): Promise<string> {
  let html = highlighted.get(code);
  if (!html) {
    html = highlightTypeScript(code);
    highlighted.set(code, html);
  }
  return html;
}

/** Lines start..end (1-based, inclusive) with their shared indentation removed. */
export function sliceSource(source: string, start: number, end: number): string {
  const lines = source.split("\n").slice(start - 1, end);
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

const GAP = 6;
const MAX_WIDTH = 860;

export function StepCodePeek({ anchor, name, source, line, endLine, tools, onPointerEnter, onPointerLeave }: {
  anchor: HTMLElement;
  name: string;
  source: string;
  line: number;
  endLine: number;
  tools: JigStepTool[];
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const snippet = sliceSource(source, line, endLine);
  const [html, setHtml] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; above: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    highlightOnce(snippet).then((h) => { if (!cancelled) setHtml(h); }).catch(() => {});
    return () => { cancelled = true; };
  }, [snippet]);

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const left = rect.left + 44;
    const width = Math.min(MAX_WIDTH, rect.right - left - 12, window.innerWidth - left - 16);
    const height = cardRef.current?.offsetHeight ?? 320;
    const above = rect.bottom + GAP + height > window.innerHeight - 12 && rect.top - GAP - height > 12;
    setPos({ top: above ? rect.top - GAP - height : rect.bottom + GAP, left, width, above });
  }, [anchor, html]);

  return createPortal(
    <div
      ref={cardRef}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      style={{
        position: "fixed",
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: pos?.width,
        transformOrigin: pos?.above ? "bottom left" : "top left",
        animation: "code-peek-in 140ms cubic-bezier(0.2, 0.9, 0.3, 1)",
      }}
      className="z-50 overflow-hidden rounded-xl border border-[#2a2a30] bg-[#0b0b0d]/95 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur-md"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-400/40 to-transparent" />
      <div className="flex items-center gap-2 border-b border-[#1c1c21] bg-[#111114] px-3 py-2">
        <span className="text-[11px] font-medium text-[#d8d8dc] truncate">{name}</span>
        <span className="font-mono text-[9px] text-[#55555c]">L{line}-{endLine}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {tools.map((tool) => {
            const { service, action } = describeTool(tool);
            return (
              <span key={`${tool.connection}:${tool.name}`} className="inline-flex items-center gap-1 rounded-full bg-[#18181c] px-1.5 py-0.5" title={`${tool.connection}.${tool.name}`}>
                <ServiceIcon name={service} size={9} />
                <span className="text-[9px] text-[#8a8a92]">{serviceName(service)} · {action}</span>
                <span className={`h-1.5 w-1.5 rounded-full ${tool.readOnly ? "bg-emerald-400/70" : "bg-amber-400/80"}`} title={tool.readOnly ? "reads" : "writes"} />
              </span>
            );
          })}
        </span>
      </div>
      <div className="relative max-h-[340px] overflow-auto py-2">
        {html ? (
          <div
            className="step-code-peek [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:text-[11px] [&_pre]:leading-[1.7] [&_code]:!bg-transparent"
            style={{ counterReset: `line ${line - 1}` }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className="px-3 font-mono text-[11px] leading-[1.7] text-[#9a9aa2] whitespace-pre">{snippet}</pre>
        )}
      </div>
    </div>,
    document.body,
  );
}

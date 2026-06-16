"use client";

import type { ReactNode } from "react";
import { RotatingFrame } from "@/components/rotating-frame";
import { Spinner } from "@/components/spinner";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

function toneClasses(tone: Tone) {
  switch (tone) {
    case "info":
      return "border-blue-500/20 bg-blue-500/[0.05] text-blue-100/80";
    case "success":
      return "border-emerald-500/20 bg-emerald-500/[0.05] text-emerald-100/80";
    case "warning":
      return "border-amber-500/20 bg-amber-500/[0.05] text-amber-100/80";
    case "danger":
      return "border-rose-500/20 bg-rose-500/[0.05] text-rose-100/80";
    default:
      return "border-[var(--border)] bg-[var(--surface-input)] text-[var(--text-secondary)]";
  }
}

function toneKickerClasses(tone: Tone) {
  switch (tone) {
    case "info":
      return "text-blue-300";
    case "success":
      return "text-emerald-300";
    case "warning":
      return "text-amber-300";
    case "danger":
      return "text-rose-300";
    default:
      return "text-[var(--text-muted)]";
  }
}

export function Notice({
  tone = "neutral",
  title,
  children,
  actions,
  className = "",
}: {
  tone?: Tone;
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border px-3 py-3 ${toneClasses(tone)} ${className}`.trim()}>
      {title ? <p className={`ui-kicker ${toneKickerClasses(tone)}`}>{title}</p> : null}
      <div className={title ? "mt-1 text-[11px] leading-relaxed" : "text-[11px] leading-relaxed"}>{children}</div>
      {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function LoadingState({
  message,
  className = "",
  lightFrame = false,
}: {
  message: string;
  className?: string;
  lightFrame?: boolean;
}) {
  if (lightFrame) {
    return (
      <RotatingFrame
        active
        className={`w-full rounded-lg border border-[var(--border)] ${className}`.trim()}
        roundedClassName="rounded-lg"
        innerRoundedClassName="rounded-[7px]"
        surfaceClassName="bg-[var(--surface)]"
      >
        <div className="flex items-center justify-center gap-2 px-4 py-6">
          <Spinner size={14} />
          <span className="text-shimmer text-[11px]">{message}</span>
        </div>
      </RotatingFrame>
    );
  }

  return (
    <div className={`flex items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-6 ${className}`.trim()}>
      <Spinner size={14} />
      <span className="text-[11px] text-[var(--text-muted)]">{message}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  className = "",
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-center ${className}`.trim()}>
      <p className="text-[12px] font-medium text-[var(--text-secondary)]">{title}</p>
      {description ? <div className="mt-1 text-[11px] leading-relaxed text-[var(--text-dim)]">{description}</div> : null}
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

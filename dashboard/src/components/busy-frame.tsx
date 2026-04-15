"use client";

import type { ReactNode } from "react";
import { RotatingFrame } from "@/components/rotating-frame";

export function BusyFrame({
  busy,
  children,
  className = "",
  innerClassName = "",
}: {
  busy: boolean;
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}) {
  return (
    <RotatingFrame
      active={busy}
      className={`${busy ? "border border-[var(--border)]" : ""} ${className}`.trim()}
      innerClassName={innerClassName}
      roundedClassName="rounded-lg"
      innerRoundedClassName="rounded-[7px]"
      surfaceClassName="bg-[var(--surface-panel)]"
    >
      {children}
    </RotatingFrame>
  );
}

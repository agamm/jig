"use client";

import type { ReactNode } from "react";

const DEFAULT_GRADIENT =
  "conic-gradient(transparent 240deg, rgba(96,165,250,0.3) 260deg, rgba(96,165,250,0.7) 275deg, rgba(96,165,250,1) 280deg, rgba(96,165,250,0.7) 285deg, rgba(96,165,250,0.3) 300deg, transparent 320deg)";

export function RotatingFrame({
  active,
  children,
  className = "",
  innerClassName = "",
  roundedClassName = "rounded-lg",
  innerRoundedClassName = "rounded-[7px]",
  surfaceClassName = "bg-[#111113]",
  duration = "3s",
  gradient = DEFAULT_GRADIENT,
  spinnerInsetClassName = "inset-[-200%]",
}: {
  active: boolean;
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  roundedClassName?: string;
  innerRoundedClassName?: string;
  surfaceClassName?: string;
  duration?: string;
  gradient?: string;
  spinnerInsetClassName?: string;
}) {
  return (
    <div className={`${active ? `relative overflow-hidden ${roundedClassName}` : ""} ${className}`.trim()}>
      {active ? (
        <>
          <div className={`pointer-events-none absolute inset-0 overflow-hidden ${roundedClassName}`}>
            <div
              className={`absolute ${spinnerInsetClassName}`}
              style={{
                animation: `spin-light ${duration} linear infinite`,
                background: gradient,
              }}
            />
          </div>
          <div className={`pointer-events-none absolute inset-[1px] ${innerRoundedClassName} ${surfaceClassName}`} />
        </>
      ) : null}
      <div className={`${active ? "relative z-10" : ""} ${innerClassName}`.trim()}>{children}</div>
    </div>
  );
}

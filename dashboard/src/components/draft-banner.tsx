"use client";

import type { ReactNode } from "react";

export function DraftBanner({
  title,
  detail,
}: {
  title: string;
  detail?: ReactNode;
}) {
  return (
    <div className="construction-stripe border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
      <span className="text-amber-400 text-[11px]">&#9888;</span>
      <span className="text-[11px] text-amber-400 font-medium">{title}</span>
      {detail ? <span className="ml-auto text-[10px] text-amber-400/55">{detail}</span> : null}
    </div>
  );
}

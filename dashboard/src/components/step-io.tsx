"use client";

import { useState } from "react";

export function StepIO({ input, output }: { input: string; output?: string }) {
  const [tab, setTab] = useState<"in" | "out">("in");
  return (
    <div className="px-4 pb-3 pt-0.5 ml-7" style={{ animation: "fade-up 0.15s ease" }}>
      <div className="rounded-md bg-[#0a0a0b] border border-[#1f1f23] overflow-hidden">
        <div className="flex border-b border-[#1f1f23]">
          <button onClick={() => setTab("in")} className={`px-3 py-1 text-[9px] uppercase tracking-wider transition-colors duration-150 ${tab === "in" ? "text-[#888] bg-[#111113] border-b-2 border-b-blue-500/50" : "text-[#444] hover:text-[#666]"}`}>Input</button>
          {output && <button onClick={() => setTab("out")} className={`px-3 py-1 text-[9px] uppercase tracking-wider transition-colors duration-150 ${tab === "out" ? "text-[#888] bg-[#111113] border-b-2 border-b-blue-500/50" : "text-[#444] hover:text-[#666]"}`}>Output</button>}
        </div>
        <div className="px-3 py-2 max-h-28 overflow-y-auto">
          <p className="text-[11px] text-[#888] font-mono whitespace-pre-wrap break-words leading-relaxed">{tab === "in" ? input : output}</p>
        </div>
      </div>
    </div>
  );
}

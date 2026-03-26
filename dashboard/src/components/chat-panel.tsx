"use client";

import type { ChatMsg } from "@/types/jig";
import { ServiceIcon } from "@/components/service-icon";

export function ChatPanel({ messages, width, onReviewClick }: {
  messages: ChatMsg[];
  width: number;
  onReviewClick: (jigId: string) => void;
}) {
  return (
    <aside className="flex shrink-0 flex-col border-r border-[#1f1f23] bg-[#0e0e10]" style={{ width }}>
      {/* Chat header */}
      <div className="flex h-11 items-center justify-between border-b border-[#1f1f23] px-4">
        <span className="text-[13px] font-semibold tracking-tight text-[#ededed]">
          <span className="text-emerald-400">&#9670;</span> Jig
        </span>
        <button className="rounded-md border border-[#1f1f23] bg-[#111113] px-2.5 py-1 text-[11px] text-[#888] transition-colors duration-150 hover:bg-[#1a1a1d] hover:text-[#ededed]">
          + New
        </button>
      </div>

      {/* Search */}
      <div className="border-b border-[#1f1f23] px-3 py-2">
        <div className="flex items-center gap-2 rounded-md border border-[#1f1f23] bg-[#111113] px-2.5 py-1.5 text-[11px] text-[#555]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          Search... &#8984;K
        </div>
      </div>

      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[224px] rounded-lg px-3 py-2 text-[12px] leading-relaxed ${
                msg.role === "user"
                  ? "bg-[#1a1a1d] text-[#ededed]"
                  : "text-[#888]"
              }`}
            >
              <p>{msg.text}</p>
              {msg.card === "task" && (
                <div className="mt-2 rounded-md border border-[#1f1f23] bg-[#111113] p-2">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[11px] font-medium text-[#ededed]">{msg.taskTitle}</p>
                    <span className="text-[9px] text-[#444]">~$0.005/run</span>
                  </div>
                  <div className="mb-1.5 text-[10px] text-[#555] leading-relaxed">
                    {msg.taskSteps?.map((s, si) => (
                      <span key={si}>{si > 0 && " \u2192 "}{s}</span>
                    ))}
                  </div>
                  <div className="mb-1.5 flex items-center gap-1 flex-wrap">
                    <ServiceIcon name="Drive" size={12} />
                    <ServiceIcon name="Gmail" size={12} />
                    <span className="text-[9px] text-[#444] ml-0.5">read ✓ · send ○</span>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => onReviewClick("invoice")}
                      className="rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-medium text-white transition-all duration-150 hover:bg-emerald-500 active:scale-95"
                    >
                      Review &rarr;
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Chat input */}
      <div className="border-t border-[#1f1f23] p-3">
        <div className="flex items-center gap-2 rounded-lg border border-[#1f1f23] bg-[#111113] px-3 py-2">
          <input
            type="text"
            placeholder="Ask Jig anything..."
            className="flex-1 bg-transparent text-[12px] text-[#ededed] outline-none placeholder:text-[#555]"
          />
          <button className="rounded-md bg-emerald-600 px-2 py-0.5 text-[10px] font-medium text-white transition-colors duration-150 hover:bg-emerald-500">
            &#8593;
          </button>
        </div>
      </div>
    </aside>
  );
}

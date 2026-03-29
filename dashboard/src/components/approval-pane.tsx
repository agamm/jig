"use client";

import { ConnectionTag } from "@/components/connection-tag";
import { StepIO } from "@/components/step-io";
import { APPROVAL_DATA } from "@/mock/mock-data";

export function ApprovalPane({ approvalId, onClose, onApprove, onReject }: {
  approvalId: string;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const data = APPROVAL_DATA[approvalId];
  if (!data) return null;

  return (
    <aside
      className="flex w-[48%] shrink-0 flex-col border-l border-amber-500/20 bg-[#0e0e10] overflow-hidden"
      style={{ animation: "slide-in-right 0.2s ease" }}
    >
      {/* Approval header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-amber-500/20 px-4 gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
          <h2 className="text-[14px] font-semibold text-amber-400">Pending Approval</h2>
        </div>
        <button
          onClick={onClose}
          className="rounded-md border border-[#1f1f23] bg-[#111113] px-2 py-1 text-[11px] text-[#555] transition-colors duration-150 hover:text-[#888] hover:bg-[#1a1a1d]"
        >
          &#10005;
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* What jig is this */}
        <div>
          <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Jig</h3>
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-[#ededed]">{data.jigName} &mdash; {data.entity}</span>
            {data.connections.map(c => <ConnectionTag key={c} name={c} />)}
          </div>
        </div>

        {/* Steps completed so far */}
        <div>
          <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Run Progress</h3>
          <div className="rounded-lg border border-[#1f1f23] bg-[#111113]">
            {data.steps.map((step, si) => (
              <details key={si} className={`group/step border-b border-dashed border-[#1a1a1d] last:border-0 ${step.status === "pending" ? "bg-amber-500/[0.04]" : step.status === "future" ? "opacity-40" : ""}`}>
                <summary className={`flex items-center gap-3 px-4 ${step.status === "pending" ? "py-3" : "py-2.5"} cursor-pointer list-none transition-colors duration-150 ${step.status === "done" ? "hover:bg-[#151517]" : ""}`}>
                  {step.status === "done" && <span className="text-emerald-400 text-[10px]">&#10003;</span>}
                  {step.status === "pending" && <span className="text-amber-400 text-[10px] animate-pulse">&#9679;</span>}
                  {step.status === "future" && <span className="text-[#333] text-[10px]">&#9679;</span>}
                  <span className={`text-[12px] flex-1 ${step.status === "pending" ? "text-amber-400 font-medium" : step.status === "future" ? "text-[#555]" : "text-[#ccc]"}`}>{step.name}</span>
                  {step.time && <span className="text-[10px] font-mono text-[#555]">{step.time}</span>}
                  {step.cost && <span className="text-[10px] font-mono text-amber-400/50">{step.cost}</span>}
                  {step.status === "pending" && <span className="text-[10px] text-amber-400/60">waiting</span>}
                  {step.status === "done" && <span className="text-[10px] text-[#333] group-open/step:rotate-90 transition-transform duration-150">&#9656;</span>}
                </summary>
                {step.status === "done" && step.input && (
                  <StepIO input={step.input} output={step.output} />
                )}
              </details>
            ))}
          </div>
        </div>

        {/* Output / payload */}
        <div>
          <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Step Output</h3>
          <div className="rounded-lg border border-[#1f1f23] bg-[#111113] p-3 font-mono text-[11px] text-[#888] leading-relaxed">
            <p>To: {data.output.to}</p>
            <p>Subject: {data.output.subject}</p>
            <p>Amount: <span className="text-[#ededed] font-semibold">{data.output.amount}</span></p>
            <p className="mt-2 text-[#555]">{data.output.detail}</p>
            <p className="text-[#555]">{data.output.source}</p>
          </div>
        </div>

        {/* Artifacts */}
        <div>
          <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Artifacts</h3>
          <div className="max-h-[300px] overflow-y-auto space-y-1.5">
            {data.artifacts.map((artifact, ai) => (
              <button key={ai} className="flex w-full items-center gap-3 rounded-md border border-[#1f1f23] bg-[#111113] px-3 py-2.5 text-left transition-colors duration-150 hover:bg-[#151517] group cursor-pointer">
                {/* SAFETY: artifact.svgPaths is from the static APPROVAL_DATA constant, never user input */}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={`${artifact.iconColor} shrink-0`} dangerouslySetInnerHTML={{ __html: artifact.svgPaths }} />
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] text-[#ccc] group-hover:text-[#ededed] transition-colors">{artifact.name}</p>
                  <p className="text-[10px] text-[#444]">{artifact.desc}</p>
                </div>
                <span className="text-[10px] text-[#333] group-hover:text-[#555] transition-colors">Preview &rarr;</span>
              </button>
            ))}
          </div>
        </div>

        {/* Approve/Reject */}
        <div className="flex gap-2">
          <button onClick={onApprove} className="flex-1 rounded-md bg-emerald-600 py-2 text-[12px] font-medium text-white transition-all duration-150 hover:bg-emerald-500 active:scale-[0.98] cursor-pointer">
            Approve &amp; Continue
          </button>
          <button onClick={onReject} className="flex-1 rounded-md border border-rose-500/30 bg-rose-500/10 py-2 text-[12px] font-medium text-rose-400 transition-all duration-150 hover:bg-rose-500/20 active:scale-[0.98] cursor-pointer">
            Reject
          </button>
        </div>
      </div>
    </aside>
  );
}

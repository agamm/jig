import type { Jig } from "@/types/jig";
import { ConnectionTag } from "@/components/connection-tag";

export function StepList({ steps, editable }: { steps: Jig["steps"]; editable?: boolean }) {
  return (
    <div className="rounded-lg border border-[#1f1f23] bg-[#111113]">
      {steps.map((step, i) => (
        <div
          key={i}
          className={`group relative flex items-start gap-3 px-4 py-3 transition-colors duration-150 hover:bg-[#151517] ${i < steps.length - 1 ? "border-b border-dashed border-[#1a1a1d]" : ""}`}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1d] text-[10px] font-mono text-[#444] mt-0.5">{step.num}</span>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-[#ddd]">{step.name}</p>
            {step.connections && step.connections.length > 0 && (
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                {[...new Set(step.connections)].map(c => (
                  <ConnectionTag key={c} name={c} />
                ))}
              </div>
            )}
          </div>
          {editable && (
            <span className="text-[10px] text-[#333] opacity-0 transition-opacity duration-150 group-hover:opacity-100 shrink-0 mt-0.5">&#9998;</span>
          )}
        </div>
      ))}
    </div>
  );
}

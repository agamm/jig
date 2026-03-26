import type { Jig } from "@/types/jig";
import { ServiceIcon } from "@/components/service-icon";

const SVC_MAP: Record<string, string> = { llm: "ai", ctx: "ai" };

export function StepList({ steps, editable }: { steps: Jig["steps"]; editable?: boolean }) {
  return (
    <div className="rounded-lg border border-[#1f1f23] bg-[#111113]">
      {steps.map((step, i) => {
        const toolMatch = step.desc.match(/^(\w+)\./);
        const toolService = toolMatch ? toolMatch[1] : null;
        const svcName = toolService ? (SVC_MAP[toolService] || toolService) : null;
        return (
          <div key={i} className={`group flex items-start gap-3 px-4 py-3 transition-colors duration-150 hover:bg-[#151517] ${i < steps.length - 1 ? "border-b border-dashed border-[#1a1a1d]" : ""}`}>
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1d] text-[10px] font-mono text-[#444] mt-0.5">{step.num}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-[#ddd]">{step.name}</p>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <span className="inline-flex items-center gap-1 rounded-full bg-[#1a1a1d] border border-[#2a2a2e] px-2 py-0.5">
                  {svcName && <ServiceIcon name={svcName} size={12} />}
                  <span className="text-[10px] text-[#888] font-mono">{step.desc}</span>
                </span>
              </div>
            </div>
            {step.cost && <span className="text-[10px] font-mono text-amber-400/60 shrink-0 mt-0.5">{step.cost}</span>}
            {(editable !== false) && (
              <span className="text-[10px] text-[#333] opacity-0 transition-opacity duration-150 group-hover:opacity-100 shrink-0 mt-0.5">&#9998;</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

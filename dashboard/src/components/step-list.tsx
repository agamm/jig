import type { Jig } from "@/types/jig";
import { ServiceIcon } from "@/components/service-icon";

export function StepList({ steps, editable }: { steps: Jig["steps"]; editable?: boolean }) {
  return (
    <div className="rounded-lg border border-[#1f1f23] bg-[#111113]">
      {steps.map((step, i) => {
        const group = step.agentGroup;
        const prevGroup = i > 0 ? steps[i - 1].agentGroup : undefined;
        const nextGroup = i < steps.length - 1 ? steps[i + 1].agentGroup : undefined;
        const isGrouped = !!group;
        const isGroupStart = isGrouped && group !== prevGroup;
        const isGroupEnd = isGrouped && group !== nextGroup;

        return (
          <div
            key={i}
            className={`group relative flex items-start gap-3 px-4 py-3 transition-colors duration-150 hover:bg-[#151517] ${i < steps.length - 1 ? "border-b border-dashed border-[#1a1a1d]" : ""}`}
          >
            {/* Agent group bar — left indicator */}
            {isGrouped && (
              <div
                className="absolute left-0 w-[3px] bg-violet-500/40"
                style={{
                  top: isGroupStart ? "12px" : 0,
                  bottom: isGroupEnd ? "12px" : 0,
                  borderRadius: isGroupStart && isGroupEnd ? "2px" : isGroupStart ? "2px 2px 0 0" : isGroupEnd ? "0 0 2px 2px" : 0,
                }}
              />
            )}
            {/* Group label — shown once at the start */}
            {isGroupStart && (
              <div className="absolute left-2 -top-2.5 bg-[#111113] px-1.5 text-[8px] text-violet-400 font-medium tracking-wide uppercase z-10">
                agent
              </div>
            )}

            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1d] text-[10px] font-mono text-[#444] mt-0.5">{step.num}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-[#ddd]">{step.name}</p>
              {(step.desc || (step.connections && step.connections.length > 0)) && (
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  {step.connections && step.connections.length > 0 && [...new Set(step.connections)].map(c => (
                    <span key={c} className="inline-flex items-center gap-1 rounded-full bg-[#1a1a1d] border border-[#2a2a2e] px-1.5 py-0.5">
                      <ServiceIcon name={c} size={11} />
                      <span className="text-[9px] text-[#666]">{c}</span>
                    </span>
                  ))}
                  {step.desc && (
                    <span className="text-[10px] text-[#555]">{step.desc}</span>
                  )}
                </div>
              )}
            </div>
            {step.cost && <span className="text-[10px] font-mono text-amber-400/60 shrink-0 mt-0.5">{step.cost}</span>}
            {editable && (
              <span className="text-[10px] text-[#333] opacity-0 transition-opacity duration-150 group-hover:opacity-100 shrink-0 mt-0.5">&#9998;</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

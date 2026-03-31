import { ServiceIcon } from "@/components/service-icon";
import { ConnectionTag } from "@/components/connection-tag";

export function OnboardingView({ onCreate }: { onCreate?: () => void }) {
  return (
    <div className="mx-auto max-w-xl space-y-6 pt-8" style={{ animation: "fade-up 0.3s ease" }}>
      <div className="text-center">
        <h2 className="text-[15px] font-semibold text-[#ededed]">Welcome to Jig</h2>
        <p className="mt-1 text-[11px] text-[#555]">0 jigs &middot; 0 connections</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[
          { name: "Connect Gmail", desc: "Read, send, and organize emails", service: "Gmail" },
          { name: "Connect Calendar", desc: "Read events and create meetings", service: "Calendar" },
          { name: "Connect Drive", desc: "Read and write documents", service: "Drive" },
        ].map(c => (
          <button key={c.name} className="group flex items-center gap-3 rounded-lg border border-[#1f1f23] bg-[#111113] p-3.5 text-left transition-colors duration-150 hover:border-[#2a2a2e] hover:bg-[#151517]">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#1a1a1d]">
              <ServiceIcon name={c.service} size={20} />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-[13px] font-medium text-[#ededed]">{c.name}</p>
                <ConnectionTag name={c.service} />
              </div>
              <p className="text-[11px] text-[#555] mt-0.5">{c.desc}</p>
            </div>
          </button>
        ))}
        <button
          onClick={onCreate}
          className="group flex items-center gap-3 rounded-lg border border-dashed border-[#2a2a2e] bg-transparent p-3.5 text-left transition-colors duration-150 hover:border-emerald-500/30 hover:bg-emerald-500/[0.03]"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-500/10 text-sm text-emerald-400">&#10024;</span>
          <div>
            <p className="text-[13px] font-medium text-[#ededed]">Create your first jig</p>
            <p className="text-[11px] text-[#555]">Describe a task, we&apos;ll automate it</p>
          </div>
        </button>
      </div>
    </div>
  );
}

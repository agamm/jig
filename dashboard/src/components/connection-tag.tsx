import { ServiceIcon } from "@/components/service-icon";

export function ConnectionTag({ name, tool, detail }: { name: string; tool?: string; detail?: string }) {
  const display = tool || name;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#1a1a1d] border border-[#2a2a2e] px-2 py-0.5">
      <ServiceIcon name={name} size={14} />
      <span className="text-[11px] text-[#888] font-mono">{display}</span>
      {detail && <span className="text-[10px] text-[#555]">{detail}</span>}
    </span>
  );
}

import Link from "next/link";
import { ServiceIcon } from "@/components/service-icon";

export function ConnectionTag({ name, tool, detail, onClick }: { name: string; tool?: string; detail?: string; onClick?: (name: string) => void }) {
  const display = tool || name;
  const className = "inline-flex items-center gap-1 rounded-full bg-[#1a1a1d] border border-[#2a2a2e] px-2 py-0.5 cursor-pointer transition-colors duration-150 hover:border-[#444] hover:bg-[#222]";
  const children = (
    <>
      <ServiceIcon name={name} size={14} />
      <span className="text-[11px] text-[#888] font-mono">{display}</span>
      {detail && <span className="text-[10px] text-[#555]">{detail}</span>}
    </>
  );

  if (onClick) {
    return <button onClick={() => onClick(name)} className={className}>{children}</button>;
  }

  return <Link href={`/connections/${encodeURIComponent(name)}`} className={className}>{children}</Link>;
}

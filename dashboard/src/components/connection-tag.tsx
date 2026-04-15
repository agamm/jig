import Link from "next/link";
import { ServiceIcon } from "@/components/service-icon";

export function ConnectionTag({ name, tool, detail, onClick }: { name: string; tool?: string; detail?: string; onClick?: (name: string) => void }) {
  const display = tool || name;
  const className = "ui-chip text-[11px] font-mono cursor-pointer focus-visible:outline-none";
  const children = (
    <>
      <ServiceIcon name={name} size={14} />
      <span className="text-[11px] text-[var(--text-secondary)]">{display}</span>
      {detail && <span className="text-[10px] text-[var(--text-dim)]">{detail}</span>}
    </>
  );

  if (onClick) {
    return <button onClick={() => onClick(name)} className={className} data-interactive="true">{children}</button>;
  }

  return <Link href={`/connections/${encodeURIComponent(name)}`} className={className} data-interactive="true">{children}</Link>;
}

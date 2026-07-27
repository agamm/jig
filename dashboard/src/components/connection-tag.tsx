import Link from "next/link";
import { ServiceIcon } from "@/components/service-icon";

export function ConnectionTag({
  name,
  tool,
  detail,
  onClick,
  interactive = true,
}: {
  name: string
  tool?: string
  detail?: string
  onClick?: (name: string) => void
  /** When false, render a non-navigating chip (e.g. unknown/unavailable connectors). */
  interactive?: boolean
}) {
  const display = tool || name;
  const className = `ui-chip text-[11px] font-mono${interactive ? " cursor-pointer focus-visible:outline-none" : ""}`;
  const children = (
    <>
      <ServiceIcon name={name} size={14} />
      <span className="text-[11px] text-[var(--text-secondary)]">{display}</span>
      {detail && <span className="text-[10px] text-[var(--text-dim)]">{detail}</span>}
    </>
  );

  if (!interactive) {
    return <span className={className}>{children}</span>;
  }

  if (onClick) {
    return <button onClick={() => onClick(name)} className={className} data-interactive="true">{children}</button>;
  }

  return <Link href={`/connections/${encodeURIComponent(name)}`} className={className} data-interactive="true">{children}</Link>;
}

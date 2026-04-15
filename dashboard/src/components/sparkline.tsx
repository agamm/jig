const DEFAULT_BAR_COLOR = "#34d399";

export function Sparkline({ data, color = DEFAULT_BAR_COLOR, colors }: { data: number[]; color?: string; colors?: string[] }) {
  const max = Math.max(...data, 1);
  return (
    <svg width="56" height="18" viewBox="0 0 56 18" className="shrink-0" style={{ minWidth: 56 }}>
      {data.map((v, i) => {
        const h = (v / max) * 14 + 2;
        return <rect key={i} x={i * 8} y={18 - h} width="5" height={h} rx="1" fill={colors?.[i] ?? color} opacity={0.5 + (v / max) * 0.5} />;
      })}
    </svg>
  );
}

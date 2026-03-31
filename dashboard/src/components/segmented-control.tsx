"use client"

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; disabled?: boolean }[]
  onChange?: (value: T) => void
}) {
  return (
    <div className="flex gap-0.5 rounded-lg border border-[#1f1f23] bg-[#0a0a0b] p-0.5 w-fit">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={option.disabled}
          onClick={() => onChange?.(option.value)}
          className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-50 ${
            value === option.value
              ? "bg-[#1a1a1d] text-[#ededed]"
              : "text-[#555] hover:text-[#888]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

"use client";

import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function TextInput({
  className = "",
  inputClassName = "",
  leading,
  trailing,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  className?: string;
  inputClassName?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  if (!leading && !trailing) {
    return <input {...props} className={`ui-input ${className} ${inputClassName}`.trim()} />;
  }

  return (
    <div className={`relative ${className}`.trim()}>
      {leading ? (
        <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-[11px] text-[var(--text-faint)]">
          {leading}
        </span>
      ) : null}
      <input
        {...props}
        className={`ui-input ${leading ? "pl-8" : ""} ${trailing ? "pr-8" : ""} ${inputClassName}`.trim()}
      />
      {trailing ? (
        <span className="absolute right-3 top-1/2 z-10 -translate-y-1/2 text-[11px] text-[var(--text-faint)]">
          {trailing}
        </span>
      ) : null}
    </div>
  );
}

export function TextArea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`ui-textarea ${className}`.trim()} />;
}

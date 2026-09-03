"use client";

/**
 * Field props for an API key or token, which is NOT a password.
 *
 * `type="password"` is the tempting choice and the wrong one: masking is the
 * signal password managers use to offer "save this login", so 1Password ends up
 * storing an AgentMail key as the vault password for the site. These are the
 * opt-outs the major managers honour. The value is visible on screen, which is
 * the trade: it is typed once, pasted from a console tab that is still open, and
 * consumed immediately.
 */
export const secretFieldProps = {
  type: "text",
  autoComplete: "off",
  spellCheck: false,
  autoCapitalize: "off",
  autoCorrect: "off",
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-form-type": "other",
} as const

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

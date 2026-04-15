"use client";

import { Button } from "@/components/button";

type TriggerState = {
  editing: boolean;
  value: string;
  setValue: (value: string) => void;
  display: string;
  saving: boolean;
  save: () => void;
  startEditing: () => void;
  cancel: () => void;
};

export function TriggerEditor({
  trigger,
  suggestions,
}: {
  trigger: TriggerState;
  suggestions: string[];
}) {
  if (trigger.editing) {
    return (
      <div className="rounded-lg border border-emerald-500/20 bg-[var(--surface)] p-3 space-y-2" style={{ animation: "fade-up 0.15s ease" }}>
        <input
          type="text"
          value={trigger.value}
          onChange={(e) => trigger.setValue(e.target.value)}
          className="ui-input"
          autoFocus
        />
        <p className="text-[10px] text-[var(--text-dim)]">Type naturally, e.g. &quot;every friday at 9am&quot;</p>
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => trigger.setValue(suggestion)}
              className="ui-chip text-[10px]"
              data-interactive="true"
            >
              {suggestion}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5 pt-1">
          <Button disabled={trigger.saving} onClick={trigger.save} variant="success" size="xs">
            {trigger.saving ? "Saving…" : "Save Trigger"}
          </Button>
          <Button onClick={trigger.cancel} variant="subtle" size="xs">
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={trigger.startEditing}
      className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-muted)] px-3 py-2 text-left transition-colors duration-150 hover:border-[#3a3a3e] hover:bg-[#202024]"
    >
      <span className="text-[12px] font-mono text-[var(--text-secondary)]">{trigger.display || "No trigger"}</span>
      <span className="text-[10px] text-[var(--text-dim)]">edit</span>
    </button>
  );
}

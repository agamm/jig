"use client";

import { useState } from "react";
import type { Jig } from "@/types/jig";
import { ConnectionTag } from "@/components/connection-tag";
import { Button } from "@/components/button";
import { DraftBanner } from "@/components/draft-banner";
import { HighlightedCode } from "@/components/highlighted-code";
import { StepList } from "@/components/step-list";
import { TRIGGER_SUGGESTIONS } from "@/lib/trigger-suggestions";
import { useTriggerSave } from "@/hooks/use-trigger-save";
import { PaneHeader } from "@/components/pane-header";
import { PaneSection } from "@/components/pane-section";
import { SegmentedControl } from "@/components/segmented-control";
import { Notice } from "@/components/state-panel";
import { TriggerEditor } from "@/components/trigger-editor";

export function ReviewPane({ jig, onClose }: {
  jig: Jig;
  onClose: () => void;
}) {
  const [detailTab, setDetailTab] = useState<"steps" | "code">("steps");
  const trigger = useTriggerSave(jig.id, jig.settings.trigger);

  return (
    <aside
      className="flex h-full w-full flex-col bg-[#0e0e10] overflow-hidden"
    >
      <DraftBanner title="Draft not compiled yet" detail="Edit the draft, then continue in the agent flow." />

      <PaneHeader
        title={jig.name}
        badge={<span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-400">draft</span>}
        actions={
          <Button onClick={onClose} variant="subtle" size="sm">
            &#10005;
          </Button>
        }
      />

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* Steps / Code toggle */}
        <SegmentedControl
          value={detailTab}
          onChange={setDetailTab}
          options={[
            { value: "steps", label: "Steps" },
            { value: "code", label: "Code" },
          ]}
        />

        {/* Steps or Code */}
        {detailTab === "steps" ? (
          <div key="steps" className="flip-enter">
            <StepList steps={jig.steps} editable />
          </div>
        ) : (
          <div key="code" className="rounded-lg border border-[#1f1f23] bg-[#111113] p-4 font-mono overflow-x-auto flip-enter">
            <HighlightedCode code={jig.code} connections={jig.settings.connections} />
          </div>
        )}

        <PaneSection title="Trigger">
          <TriggerEditor trigger={trigger} suggestions={TRIGGER_SUGGESTIONS} />
        </PaneSection>

        <PaneSection title="Connections">
          <div className="flex flex-wrap gap-1.5">
            {jig.settings.connections.map(c => (
              <ConnectionTag key={c} name={c} />
            ))}
          </div>
        </PaneSection>

        <Notice tone="warning" title="Draft workflow">
          Draft compilation is still driven by the agent workflow. This pane is for reviewing the draft shape and polishing the trigger before you continue.
        </Notice>
      </div>
    </aside>
  );
}

"use client";

import * as React from "react";
import {
  Group,
  Panel,
  Separator,
  type GroupProps,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels";

type ResizablePanelGroupProps = Omit<GroupProps, "orientation"> & {
  direction?: "horizontal" | "vertical";
};

export function ResizablePanelGroup({ className = "", direction = "horizontal", ...props }: ResizablePanelGroupProps) {
  return (
    <Group
      orientation={direction}
      className={`flex h-full w-full data-[panel-group-direction=vertical]:flex-col ${className}`.trim()}
      {...props}
    />
  );
}

export function ResizablePanel(props: PanelProps) {
  return <Panel {...props} />;
}

export function ResizableHandle({ className = "", ...props }: SeparatorProps) {
  return (
    <Separator
      className={`group relative flex w-2 shrink-0 items-stretch justify-center bg-transparent outline-none data-[panel-group-direction=vertical]:h-2 data-[panel-group-direction=vertical]:w-full ${className}`.trim()}
      {...props}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[#1f1f23] transition-colors group-hover:bg-[#3a3a3f] group-data-[resize-handle-state=drag]:bg-emerald-400/70 data-[panel-group-direction=vertical]:inset-x-0 data-[panel-group-direction=vertical]:top-1/2 data-[panel-group-direction=vertical]:left-0 data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-auto data-[panel-group-direction=vertical]:-translate-y-1/2 data-[panel-group-direction=vertical]:translate-x-0" />
    </Separator>
  );
}

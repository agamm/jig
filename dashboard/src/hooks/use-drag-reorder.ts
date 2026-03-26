"use client";

import { useState, useCallback } from "react";

export function useDragReorder<T>() {
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);
  const [dropSide, setDropSide] = useState<"above" | "below">("below");

  const getDragProps = useCallback((idx: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      setDraggingIdx(idx);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(idx));
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      setDropTargetIdx(idx);
      setDropSide(e.clientY < midY ? "above" : "below");
    },
    onDragLeave: () => {
      if (dropTargetIdx === idx) setDropTargetIdx(null);
    },
    onDragEnd: () => { setDraggingIdx(null); setDropTargetIdx(null); },
  }), [dropTargetIdx]);

  const handleDrop = useCallback((idx: number, items: T[], setItems: (items: T[]) => void) => {
    const fromIdx = draggingIdx;
    if (fromIdx === null || fromIdx === idx) { setDraggingIdx(null); setDropTargetIdx(null); return; }
    const arr = [...items];
    const [moved] = arr.splice(fromIdx, 1);
    let toIdx = dropSide === "above" ? idx : idx + 1;
    if (fromIdx < idx) toIdx -= 1;
    arr.splice(toIdx, 0, moved);
    setItems(arr);
    setDraggingIdx(null);
    setDropTargetIdx(null);
  }, [draggingIdx, dropSide]);

  return { draggingIdx, dropTargetIdx, dropSide, getDragProps, handleDrop };
}

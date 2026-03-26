"use client";

import { useState, useRef, useCallback, useEffect } from "react";

export function useResizablePane(opts: { initial: number; min: number; max: number }) {
  const [width, setWidth] = useState(opts.initial);
  const isResizing = useRef(false);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const w = Math.min(opts.max, Math.max(opts.min, e.clientX));
      setWidth(w);
    };
    const onMouseUp = () => { isResizing.current = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; document.querySelectorAll("[data-dragging]").forEach(el => el.removeAttribute("data-dragging")); };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => { document.removeEventListener("mousemove", onMouseMove); document.removeEventListener("mouseup", onMouseUp); };
  }, [opts.max, opts.min]);

  const startResize = useCallback(() => {
    isResizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  return { width, startResize, isResizing: isResizing.current };
}

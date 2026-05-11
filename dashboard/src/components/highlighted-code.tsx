"use client";

import { useEffect, useState } from "react";
import { highlightTypeScript } from "@/lib/syntax-highlight";

type HighlightState =
  | { status: "loading"; html: null; error: null }
  | { status: "ready"; html: string; error: null }
  | { status: "error"; html: null; error: string }

export function HighlightedCode({ code }: { code: string; connections?: string[] }) {
  const [highlight, setHighlight] = useState<HighlightState>({
    status: "loading",
    html: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setHighlight({ status: "loading", html: null, error: null });

    highlightTypeScript(code)
      .then((html) => {
        if (!cancelled) setHighlight({ status: "ready", html, error: null });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Syntax highlighting failed";
        if (!cancelled) setHighlight({ status: "error", html: null, error: message });
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (highlight.status === "ready") {
    return (
      <div
        className="[&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:overflow-x-auto [&_pre]:text-[12px] [&_pre]:leading-7 [&_code]:!bg-transparent"
        dangerouslySetInnerHTML={{ __html: highlight.html }}
      />
    );
  }

  return (
    <div>
      {highlight.status === "error" && (
        <div className="mb-3 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[10px] text-amber-200">
          Syntax highlighting unavailable: {highlight.error}
        </div>
      )}
      <pre className="whitespace-pre-wrap text-[12px] leading-7 text-[#d4d4d8]">
        {code}
      </pre>
    </div>
  );
}

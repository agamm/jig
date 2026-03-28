import { useMemo } from "react";
import type { Token } from "@/types/jig";
import { ServiceIcon } from "@/components/service-icon";

/**
 * Tokenize an entire code block (not line-by-line).
 * Handles multi-line template literals so words inside strings
 * are never tagged as service badges.
 */
function tokenizeFull(code: string, connections: string[]): Token[] {
  const connSet = new Set(connections.map(c => c.toLowerCase()));
  // Build regex for service.method calls and standalone service names
  const connPattern = connections.length > 0
    ? connections.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    : null;
  const svcMethodRe = connPattern ? new RegExp(`^((?:${connPattern})\\.\\w+)`, "i") : null;
  const svcNameRe = connPattern ? new RegExp(`^(${connPattern})\\b`, "i") : null;

  const tokens: Token[] = [];
  let remaining = code;
  while (remaining.length > 0) {
    // Line comment — matches rest of line
    let m = remaining.match(/^(\/\/[^\n]*)/);
    if (m) { tokens.push({ text: m[1], color: "text-[#555] italic" }); remaining = remaining.slice(m[1].length); continue; }

    // Block comment — multi-line
    m = remaining.match(/^(\/\*[\s\S]*?\*\/)/);
    if (m) { tokens.push({ text: m[1], color: "text-[#555] italic" }); remaining = remaining.slice(m[1].length); continue; }

    // String — double/single quote (single-line) + backtick (multi-line via s flag)
    m = remaining.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
    if (m) { tokens.push({ text: m[1], color: "text-emerald-400" }); remaining = remaining.slice(m[1].length); continue; }
    // Template literal — multi-line ([\s\S] matches newlines without the s flag)
    m = remaining.match(/^(`(?:[^`\\]|\\[\s\S])*`)/);
    if (m) { tokens.push({ text: m[1], color: "text-emerald-400" }); remaining = remaining.slice(m[1].length); continue; }

    // Newline — preserve as its own token for line splitting
    if (remaining[0] === "\n") { tokens.push({ text: "\n", color: "" }); remaining = remaining.slice(1); continue; }

    // Keyword
    m = remaining.match(/^(import|from|export|default|async|await|const|let|var|return|if|else|for|of|in|function|new|throw|try|catch|typeof|void)\b/);
    if (m) { tokens.push({ text: m[1], color: "text-violet-400" }); remaining = remaining.slice(m[1].length); continue; }

    // Service.method calls (e.g. workspace.gmail_search, github.list_commits)
    if (svcMethodRe) {
      m = remaining.match(svcMethodRe);
      if (m) { tokens.push({ text: m[1], color: "text-amber-400 __svc__" }); remaining = remaining.slice(m[1].length); continue; }
    }

    // Standalone service names — only in import context (preceded by { or ,)
    if (svcNameRe) {
      m = remaining.match(svcNameRe);
      if (m && connSet.has(m[1].toLowerCase())) {
        const before = code.slice(0, code.length - remaining.length).trimEnd();
        const lastChar = before[before.length - 1];
        if (lastChar === "{" || lastChar === ",") {
          tokens.push({ text: m[1], color: "text-amber-400 __svc__" }); remaining = remaining.slice(m[1].length); continue;
        }
        tokens.push({ text: m[1], color: "text-[#ccc]" }); remaining = remaining.slice(m[1].length); continue;
      }
    }

    // Function-like names
    m = remaining.match(/^(jig|llm|ctx\.\w+|ai\.\w+|agent)/);
    if (m) { tokens.push({ text: m[1], color: "text-amber-400" }); remaining = remaining.slice(m[1].length); continue; }

    // Number
    m = remaining.match(/^(\d+(?:\.\d+)?)\b/);
    if (m) { tokens.push({ text: m[1], color: "text-blue-400" }); remaining = remaining.slice(m[1].length); continue; }

    // Punctuation
    m = remaining.match(/^([{}()\[\];:,=>.+\-*/!?&|]+)/);
    if (m) { tokens.push({ text: m[1], color: "text-[#666]" }); remaining = remaining.slice(m[1].length); continue; }

    // Whitespace (not newlines — those are handled above)
    m = remaining.match(/^([ \t]+)/);
    if (m) { tokens.push({ text: m[1], color: "" }); remaining = remaining.slice(m[1].length); continue; }

    // Identifier / other
    m = remaining.match(/^([a-zA-Z_$][\w$]*)/);
    if (m) { tokens.push({ text: m[1], color: "text-[#ccc]" }); remaining = remaining.slice(m[1].length); continue; }

    // Fallback: single char
    tokens.push({ text: remaining[0], color: "text-[#ccc]" });
    remaining = remaining.slice(1);
  }
  return tokens;
}

/**
 * Tokenize code and split into lines for rendering.
 * Multi-line tokens (template literals, block comments) are split at newlines.
 */
function tokenizeCode(code: string, connections: string[]): Token[][] {
  const allTokens = tokenizeFull(code, connections);
  const lines: Token[][] = [[]];
  for (const tok of allTokens) {
    if (tok.text === "\n") {
      lines.push([]);
    } else if (tok.text.includes("\n")) {
      const parts = tok.text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) lines.push([]);
        if (parts[i]) lines[lines.length - 1].push({ text: parts[i], color: tok.color });
      }
    } else {
      lines[lines.length - 1].push(tok);
    }
  }
  return lines;
}

export function HighlightedCode({ code, connections = [] }: { code: string; connections?: string[] }) {
  const lines = useMemo(() => tokenizeCode(code, connections), [code, connections]);
  return (
    <pre className="whitespace-pre-wrap text-[12px] leading-7">
      {lines.map((tokens, li) => {
        const elements: React.ReactNode[] = [];
        tokens.forEach((tok, ti) => {
          if (tok.color.includes("__svc__")) {
            const svcName = tok.text.split(".")[0];
            elements.push(
              <span key={`badge-${ti}`} className="inline-flex items-center gap-1 align-middle mx-0.5 rounded-full bg-[#1a1a1d] border border-[#2a2a2e] px-1.5 py-px">
                <ServiceIcon name={svcName} size={10} />
                <span className="text-amber-400">{tok.text}</span>
              </span>
            );
            return;
          }
          elements.push(<span key={ti} className={tok.color}>{tok.text}</span>);
        });
        return <div key={li}>{elements}</div>;
      })}
    </pre>
  );
}

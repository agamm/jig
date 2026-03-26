import type { Token } from "@/types/jig";
import { ServiceIcon } from "@/components/service-icon";

export const SERVICE_KEYWORDS: Record<string, string> = {
  "gmail": "Gmail", "calendar": "Calendar", "drive": "Drive",
  "github": "GitHub", "slack": "Slack", "workspace": "Gmail",
};

/**
 * Tokenize an entire code block (not line-by-line).
 * Handles multi-line template literals so words inside strings
 * are never tagged as service badges.
 */
function tokenizeFull(code: string): Token[] {
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

    // Service.method calls (workspace.gmail_search, github.list_commits, etc.)
    m = remaining.match(/^(gmail\.\w+|calendar\.\w+|drive\.\w+|github\.\w+|slack\.\w+|workspace\.\w+|granola\.\w+)/);
    if (m) { tokens.push({ text: m[1], color: "text-amber-400 __svc__" }); remaining = remaining.slice(m[1].length); continue; }

    // Standalone service names — only in import context (preceded by { or ,)
    // This prevents tagging "calendar" in regular code as a service badge
    m = remaining.match(/^(gmail|calendar|drive|github|slack|granola)\b/);
    if (m) {
      // Check if this looks like an import (previous non-whitespace token is { or ,)
      const before = code.slice(0, code.length - remaining.length);
      const trimmed = before.trimEnd();
      const lastChar = trimmed[trimmed.length - 1];
      if (lastChar === "{" || lastChar === ",") {
        tokens.push({ text: m[1], color: "text-amber-400 __svc__" }); remaining = remaining.slice(m[1].length); continue;
      }
      // Otherwise, treat as regular identifier
      tokens.push({ text: m[1], color: "text-[#ccc]" }); remaining = remaining.slice(m[1].length); continue;
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
function tokenizeCode(code: string): Token[][] {
  const allTokens = tokenizeFull(code);
  const lines: Token[][] = [[]];
  for (const tok of allTokens) {
    if (tok.text === "\n") {
      lines.push([]);
    } else if (tok.text.includes("\n")) {
      // Multi-line token (template literal, block comment) — split at newlines
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

export function HighlightedCode({ code }: { code: string }) {
  const lines = tokenizeCode(code);
  return (
    <pre className="whitespace-pre-wrap text-[12px] leading-7">
      {lines.map((tokens, li) => {
        const elements: React.ReactNode[] = [];
        tokens.forEach((tok, ti) => {
          // Service.method tokens are marked with __svc__ — render as badge
          if (tok.color.includes("__svc__")) {
            const svcKey = tok.text.split(".")[0].toLowerCase();
            const svcName = SERVICE_KEYWORDS[svcKey] || svcKey;
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

import type { Token } from "@/types/jig";
import { ServiceIcon } from "@/components/service-icon";

export const SERVICE_KEYWORDS: Record<string, string> = {
  "gmail": "Gmail", "calendar": "Calendar", "drive": "Drive",
  "github": "GitHub", "slack": "Slack", "workspace": "Gmail",
};

export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let remaining = line;
  while (remaining.length > 0) {
    // Comment — matches rest of line
    let m = remaining.match(/^(\/\/.*$)/);
    if (m) { tokens.push({ text: m[1], color: "text-[#555] italic" }); remaining = remaining.slice(m[1].length); continue; }

    // String
    m = remaining.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/);
    if (m) { tokens.push({ text: m[1], color: "text-emerald-400" }); remaining = remaining.slice(m[1].length); continue; }

    // Keyword
    m = remaining.match(/^(import|from|export|default|async|await|const|let|var|return|if|else|for|of|in|function|new|throw|try|catch|typeof|void)\b/);
    if (m) { tokens.push({ text: m[1], color: "text-violet-400" }); remaining = remaining.slice(m[1].length); continue; }

    // Service.method calls (gmail.list, calendar.nextMeeting, drive.read, etc.)
    m = remaining.match(/^(gmail\.\w+|calendar\.\w+|drive\.\w+|github\.\w+|slack\.\w+|workspace\.\w+)/);
    if (m) { tokens.push({ text: m[1], color: "text-amber-400 __svc__" }); remaining = remaining.slice(m[1].length); continue; }

    // Standalone service names (in imports like "import { gmail, ai }")
    m = remaining.match(/^(gmail|calendar|drive|github|slack)\b/);
    if (m) { tokens.push({ text: m[1], color: "text-amber-400 __svc__" }); remaining = remaining.slice(m[1].length); continue; }

    // Function-like names (before general identifiers)
    m = remaining.match(/^(jig|llm|ctx\.\w+|ai\.\w+)/);
    if (m) { tokens.push({ text: m[1], color: "text-amber-400" }); remaining = remaining.slice(m[1].length); continue; }

    // Number
    m = remaining.match(/^(\d+(?:\.\d+)?)\b/);
    if (m) { tokens.push({ text: m[1], color: "text-blue-400" }); remaining = remaining.slice(m[1].length); continue; }

    // Punctuation
    m = remaining.match(/^([{}()\[\];:,=>.+\-*/!?&|]+)/);
    if (m) { tokens.push({ text: m[1], color: "text-[#666]" }); remaining = remaining.slice(m[1].length); continue; }

    // Whitespace
    m = remaining.match(/^(\s+)/);
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

export function HighlightedCode({ code }: { code: string }) {
  const lines = code.split("\n");
  return (
    <pre className="whitespace-pre-wrap text-[12px] leading-7">
      {lines.map((line, li) => {
        const tokens = tokenizeLine(line);
        // Render tokens, injecting service icon BEFORE service.method references
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

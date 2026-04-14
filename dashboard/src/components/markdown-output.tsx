"use client";

import { Fragment } from "react";

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "rule" }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "code"; code: string };

function renderInline(text: string) {
  const parts: Array<
    | { type: "text" | "code" | "strong"; value: string }
    | { type: "link"; label: string; href: string }
  > = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push({ type: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (linkMatch) {
        parts.push({ type: "link", label: linkMatch[1], href: linkMatch[2] });
      } else {
        parts.push({ type: "text", value: token });
      }
    } else if (token.startsWith("http://") || token.startsWith("https://")) {
      const href = token.replace(/[.,!?;:]+$/, "");
      const suffix = token.slice(href.length);
      parts.push({ type: "link", label: href, href });
      if (suffix) {
        parts.push({ type: "text", value: suffix });
      }
    } else {
      parts.push({ type: "strong", value: token.slice(2, -2) });
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: "text", value: text.slice(lastIndex) });
  }

  return parts.map((part, index) => {
    if (part.type === "code") {
      return (
        <code key={index} className="rounded bg-[#151517] px-1 py-[1px] text-[#d9d9dd]">
          {part.value}
        </code>
      );
    }
    if (part.type === "strong") {
      return <strong key={index} className="font-semibold text-[#e7e7ea]">{part.value}</strong>;
    }
    if (part.type === "link") {
      return (
        <a
          key={index}
          href={part.href}
          target="_blank"
          rel="noreferrer"
          className="text-[#8ec5ff] underline underline-offset-2 decoration-[#365a7a] hover:text-[#b6daff]"
        >
          {part.label}
        </a>
      );
    }
    return <Fragment key={index}>{part.value}</Fragment>;
  });
}

function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const splitTableRow = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  const isTableDivider = (line: string) => {
    const cells = splitTableRow(line);
    return (
      cells.length > 0 &&
      cells.every((cell) => /^:?-{3,}:?$/.test(cell))
    );
  };

  while (i < lines.length) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", code: codeLines.join("\n") });
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      lines[i + 1].trim().includes("|") &&
      isTableDivider(lines[i + 1].trim())
    ) {
      const headers = splitTableRow(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const next = lines[i].trim();
        if (!next || !next.includes("|")) break;
        const row = splitTableRow(next);
        if (row.length !== headers.length) break;
        rows.push(row);
        i += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2],
      });
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    const paragraphLines = [trimmed];
    i += 1;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (
        !next ||
        next.startsWith("```") ||
        /^#{1,3}\s+/.test(next) ||
        /^[-*]\s+/.test(next) ||
        /^\d+\.\s+/.test(next) ||
        /^---+$/.test(next) ||
        (next.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1].trim()))
      ) {
        break;
      }
      paragraphLines.push(next);
      i += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

export function MarkdownOutput({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown);

  return (
    <div className="space-y-3 text-[11px] leading-relaxed text-[#b5b5ba]">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const cls =
            block.level === 1
              ? "text-[18px] font-semibold text-[#f0f0f2]"
              : block.level === 2
                ? "text-[15px] font-semibold text-[#e7e7ea]"
                : "text-[13px] font-semibold text-[#dddddf]";
          return <h3 key={index} className={cls}>{renderInline(block.text)}</h3>;
        }
        if (block.type === "paragraph") {
          return <p key={index}>{renderInline(block.text)}</p>;
        }
        if (block.type === "rule") {
          return <div key={index} className="border-t border-[#1f1f23]" />;
        }
        if (block.type === "code") {
          return (
            <pre key={index} className="overflow-x-auto rounded-md border border-[#1f1f23] bg-[#0d0d0f] p-3 font-mono text-[10px] text-[#d3d3d7]">
              {block.code}
            </pre>
          );
        }
        if (block.type === "table") {
          return (
            <div key={index} className="overflow-x-auto rounded-md border border-[#1f1f23] bg-[#101012]">
              <table className="min-w-full border-collapse text-left text-[11px]">
                <thead className="bg-[#151517] text-[#dddddf]">
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={headerIndex} className="border-b border-[#232327] px-3 py-2 font-medium">
                        {renderInline(header)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-b border-[#1a1a1d] last:border-b-0">
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="px-3 py-2 align-top text-[#bfc0c5]">
                          {renderInline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        const ListTag = block.ordered ? "ol" : "ul";
        return (
          <ListTag key={index} className={`space-y-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{renderInline(item)}</li>
            ))}
          </ListTag>
        );
      })}
    </div>
  );
}

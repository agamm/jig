import type { JigStepTool } from "@shared/api";

const SERVICE_NAMES: Record<string, string> = {
  ai: "AI", github: "GitHub", gmail: "Gmail", googlecalendar: "Google Calendar", googledrive: "Google Drive",
  googlesheets: "Google Sheets", googledocs: "Google Docs", hackernews: "Hacker News", linkedin: "LinkedIn",
  youtube: "YouTube", workspace: "Google Workspace",
};

export function serviceName(key: string): string {
  return SERVICE_NAMES[key] ?? key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function sentence(snake: string): string {
  const words = snake.replace(/[-_]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The app a tool acts on and what it does there, e.g. composio.granola_mcp_list_meetings -> Granola, "List meetings". */
export function describeTool(tool: JigStepTool): { service: string; action: string } {
  const model = tool.name.match(/^(llm|agent)\((.+)\)$/);
  if (model) return { service: "ai", action: model[1] === "agent" ? `Agent · ${model[2]}` : model[2] };
  // Composio names lead with the toolkit; "_mcp_" marks toolkits served over MCP.
  if (tool.connection === "composio") {
    const [toolkit, ...rest] = tool.name.split("_");
    return { service: toolkit.toLowerCase(), action: sentence(rest.join("_").replace(/^mcp_/, "")) };
  }
  return { service: tool.connection, action: sentence(tool.name) };
}

function nounOf(expr: string): string {
  const last = expr.split(".").pop() ?? expr;
  return last.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function describeClause(clause: string): string | null {
  const c = clause.trim();
  let m = c.match(/^([\w.]+)\.length\s*(?:===?\s*0|<\s*1)$/) ?? c.match(/^!([\w.]+)\.length$/);
  if (m) return `no ${nounOf(m[1])}`;
  if ((m = c.match(/^([\w.]+)\.length\s*(?:>\s*0|>=\s*1|!==?\s*0)$/) ?? c.match(/^([\w.]+)\.length$/))) return `any ${nounOf(m[1])}`;
  if ((m = c.match(/^!([\w.]+)$/))) return `no ${nounOf(m[1])}`;
  if ((m = c.match(/^([\w.]+)\s*===?\s*(["'`])(.*)\2$/))) return `${nounOf(m[1])} is "${m[3]}"`;
  return null;
}

/** Plain words for a step's `if` condition, or null when it is too involved to paraphrase. */
export function describeCondition(cond: string): string | null {
  if (/[()]/.test(cond) || (cond.includes("||") && cond.includes("&&"))) return null;
  const joiner = cond.includes("||") ? " or " : " and ";
  const parts = cond.split(/\|\||&&/).map(describeClause);
  return parts.every(Boolean) ? parts.join(joiner) : null;
}

export type Phase = "day1" | "week2" | "month3";

export interface RunStepEntry {
  label: string;
  time: string;
  cost?: string;
  tag?: string;
  healed?: boolean;
  output?: string;
}

export interface RunEntry {
  date: string;
  duration: string;
  status: "success" | "fail";
  cost: string;
  steps?: RunStepEntry[];
}

export interface JigEntity {
  name: string;
  lastRun: string;
  status: "success" | "fail";
}

export interface Jig {
  id: string;
  name: string;
  trigger: string;
  status: "healthy" | "attention" | "failed";
  running?: boolean;
  grouped?: boolean;
  entityCount?: number;
  entities?: JigEntity[];
  sparkline: number[];
  steps: { num: number; name: string; connections?: string[] }[];
  params?: Record<string, string>;
  code: string;
  runs: RunEntry[];
  settings: { trigger: string; connections: string[]; permissions: string[] };
  costMonth?: string;
  costLifetime?: string;
}

export interface ChatMsg {
  role: "assistant" | "user";
  text: string;
  card?: "task";
  taskTitle?: string;
  taskSteps?: string[];
  taskTools?: string;
}

export interface Token {
  text: string;
  color: string;
}

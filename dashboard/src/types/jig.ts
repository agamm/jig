import type {
  JigData,
  JigRun,
  JigRunStep,
} from "@shared/api"

export type Phase = "day1" | "week2" | "month3";
export type RunStepEntry = JigRunStep;
export type RunEntry = JigRun;
export type Jig = JigData;

export interface Token {
  text: string;
  color: string;
}

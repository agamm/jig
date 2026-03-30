import type {
  JigDto,
  JigEntityDto,
  JigRunDto,
  JigRunStepDto,
} from "@shared/api"

export type Phase = "day1" | "week2" | "month3";
export type RunStepEntry = JigRunStepDto;
export type RunEntry = JigRunDto;
export type JigEntity = JigEntityDto;
export type Jig = JigDto;

export interface Token {
  text: string;
  color: string;
}

import type { CaseInfo, SubtaskInfo } from "../interfaces";
import type { CaseStatus, JudgeStatus, StandardRunResult } from "../interfaces";

export interface Adapter {
  createSubtaskResults: () => Promise<SubtaskInfo[]>;
  createCaseResults: (
    subtask_id: string,
    subtask_result_id: string,
    dataMap: Map<string, string>,
  ) => Promise<CaseInfo[]>;

  updateStatus: (s: JudgeStatus, msg?: string) => Promise<unknown>;
  finalize: (
    s: JudgeStatus,
    info: { score: number; time: number; memory: number },
  ) => Promise<unknown>;

  finalizeSubtask: (
    result_id: string,
    info: { score: number; time: number; memory: number },
  ) => Promise<unknown>;

  updateCaseStatus: (result_id: string, status: CaseStatus) => Promise<unknown>;
  finalizeCase: (
    result_id: string,
    status: CaseStatus,
    result: StandardRunResult,
  ) => Promise<unknown>;
}

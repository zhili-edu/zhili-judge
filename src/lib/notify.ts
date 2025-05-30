import { encode } from "cbor-x";
import type { TransactionSql } from "postgres";
import type {
  CaseStatus,
  CaseUpdate,
  JudgeStatus,
  SubmissionUpdate,
  SubtaskUpdate,
} from "../interfaces.js";

export const notify = async (sid: string, sql: TransactionSql) => {
  const sub = await sql<
    ({
      submission_score: number;
      judge_status: JudgeStatus;
      submission_time: number;
      submission_memory: number;
    } & (
      | {
          subtask_id: string;
          kind: "sum" | "min";
          subtask_score: number;
        }
      | {
          subtask_id: null;
          kind: null;
          subtask_score: null;
        }
    ) &
      (
        | {
            case_num: number;
            case_time: number;
            case_memory: number;
            case_status: CaseStatus | null;
          }
        | {
            case_num: null;
            case_time: null;
            case_memory: null;
            case_status: null;
          }
      ))[]
  >`
    SELECT
      s.score AS submission_score, s.status AS judge_status,
      s.time_usage AS submission_time, s.memory_usage AS submission_memory,

      sub.id AS subtask_id, sub.kind, sub.score AS subtask_score,

      c.num AS case_num, c.time_usage AS case_time, c.memory_usage AS case_memory,
      c.status AS case_status
    FROM submissions s
      LEFT JOIN subtask_results sub ON sub.submission_id = s.id
      LEFT JOIN case_results c ON c.subtask_id = sub.id
    WHERE s.id = ${sid};
  `;

  if (sub.length === 0) return; // Not Found

  const subtasks: SubtaskUpdate[] = [];

  if (sub[0].subtask_id !== null) {
    for (const [idx, c] of sub.entries()) {
      if (c.subtask_id === null) throw "subtask_id null, impossible";

      const caseUpdate: CaseUpdate | null = c.case_num
        ? { status: c.case_status, time: c.case_time, memory: c.case_memory }
        : null;

      if (idx === 0 || c.subtask_id !== sub[idx - 1].subtask_id) {
        // first case or case with a new subtask_id
        // create a new subtask
        subtasks.push(
          caseUpdate
            ? { kind: c.kind, cases: [caseUpdate] }
            : { kind: c.kind, cases: [] },
        );
      } else if (caseUpdate !== null) {
        // append to current subtask
        subtasks.at(-1)?.cases.push(caseUpdate);
      }
    }
  }

  const data: SubmissionUpdate & { id: Buffer } = {
    id: Buffer.from(sid.replaceAll("-", ""), "hex"),
    status: sub[0].judge_status,
    subtasks,
  };

  const payload = encode(data).toString("base64");
  await sql.notify("submission", payload);
};

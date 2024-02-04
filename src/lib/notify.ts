import type { TransactionSql } from 'postgres';
import type {
    CaseEmit,
    CaseStatus,
    JudgeStatus,
    SubmissionUpdate,
    SubtaskEmit,
} from '../interfaces';

export const notify = async (sid: string, sql: TransactionSql) => {
    const sub = await sql<
        ({
            submission_score: number;
            judge_status: JudgeStatus;
            submission_time: number;
            submission_memory: number;
            submission_message: string | null;
        } & (
            | {
                  subtask_id: string;
                  kind: 'sum' | 'min';
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

                      user_in: string | null;
                      user_out: string | null;
                      user_error: string | null;
                      answer_out: string | null;
                      spj_message: string | null;
                      system_message: string | null;
                  }
                | {
                      case_num: null;
                      case_time: null;
                      case_memory: null;
                      case_status: null;

                      user_in: null;
                      user_out: null;
                      user_error: null;
                      answer_out: null;
                      spj_message: null;
                      system_message: null;
                  }
            ))[]
    >`
            SELECT
                s.score AS submission_score, s.status AS judge_status,
                s.time_usage AS submission_time, s.memory_usage AS submission_memory, s.error_message AS submission_error,

                sub.id AS subtask_id, sub.kind, sub.score AS subtask_score,

                c.num AS case_num, c.time_usage AS case_time, c.memory_usage AS case_memory,
                c.status AS case_status, user_in, user_out, user_error, answer_out, spj_message, system_message
            FROM submissions s
            LEFT JOIN subtask_results sub ON sub.submission_id = s.id
            LEFT JOIN case_results c ON c.subtask_id = sub.id
            WHERE s.id = ${sid};
        `;

    if (sub.length === 0) return; // Not Found

    const subtasks: SubtaskEmit[] = [];

    if (sub[0].subtask_id !== null) {
        for (const [idx, c] of sub.entries()) {
            if (c.subtask_id === null) throw 'subtask_id null, impossible';

            const case_result: CaseEmit | null = c.case_num
                ? {
                      num: c.case_num,

                      time_usage: c.case_time,
                      memory_usage: c.case_memory,
                      case_status: c.case_status,

                      user_in: c.user_in,
                      user_out: c.user_out,
                      user_error: c.user_error,
                      answer_out: c.answer_out,
                      spj_message: c.spj_message,
                      system_message: c.system_message,
                  }
                : null;

            if (idx === 0 || c.subtask_id !== sub[idx - 1].subtask_id) {
                subtasks.push({
                    cases: case_result ? [case_result] : [],

                    score: c.subtask_score,
                    kind: c.kind,
                });
            } else {
                if (case_result !== null) {
                    subtasks.at(-1)!.cases.push(case_result);
                }
            }
        }
    }

    const data: SubmissionUpdate & { id: string } = {
        id: sid,
        score: sub[0].submission_score,
        judge_status: sub[0].judge_status,
        time_usage: sub[0].submission_time,
        memory_usage: sub[0].submission_memory,
        error_message: sub[0].submission_message,

        subtasks,
    };

    await sql.notify('submission', JSON.stringify(data));
};

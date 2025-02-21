import type { TransactionSql } from "postgres";
import type {
  CaseInfo,
  CaseStatus,
  JudgeStatus,
  StandardRunResult,
  SubtaskInfo,
} from "../interfaces.js";
import { notify } from "../lib/notify.js";
import { sanitizeDbString } from "../utils.js";
import type { Adapter } from "./index.js";

export class NormalAdapter implements Adapter {
  sql: TransactionSql;
  sid: string;
  test_id: string;

  constructor(sql: TransactionSql, sid: string, test_id: string) {
    this.sql = sql;
    this.sid = sid;
    this.test_id = test_id;
  }

  createSubtaskResults() {
    return this.sql<SubtaskInfo[]>`
      WITH results AS (
        INSERT INTO subtask_results
          (submission_id, num, score, time_usage, memory_usage, kind)
        SELECT
          ${this.sid} AS submission_id,
          num,
          0 AS score,
          0 AS time_usage,
          0 AS memory_usage,
          kind
        FROM subtasks
        WHERE test_id = ${this.test_id}
        RETURNING id, num
      )

      SELECT
        subtasks.id AS subtask_id, subtasks.score,
        results.id AS result_id
      FROM subtasks JOIN results USING (num)
      WHERE test_id = ${this.test_id}
      ORDER BY num ASC;
    `;
  }

  createCaseResults(
    subtask_id: string,
    subtask_result_id: string,
    dataMap: Map<string, string>,
  ) {
    return this.sql<CaseInfo[]>`
      WITH file_contents AS (
        SELECT *
        FROM (VALUES ${this.sql(Array.from(dataMap.entries()))}) AS t (object_name, content)
      ),

      results AS (
        INSERT INTO case_results
          (subtask_id, num, time_usage, memory_usage, status, user_in, answer_out)
        SELECT
          ${subtask_result_id} AS subtask_id,
          num,
          0 AS time_usage,
          0 AS memory_usage,
          'waiting' AS status,
          inputs.content AS user_in,
          outputs.content AS answer_out
        FROM test_cases
          LEFT JOIN file_contents inputs ON input_file_object_name = inputs.object_name
          LEFT JOIN file_contents outputs ON output_file_object_name = outputs.object_name
        WHERE subtask_id = ${subtask_id}
        RETURNING id, num
      )

      SELECT
        results.id AS result_id,
        input_file_object_name, output_file_object_name
      FROM test_cases JOIN results USING (num)
      WHERE subtask_id = ${subtask_id}
      ORDER BY num ASC;
    `;
  }

  async updateStatus(status: JudgeStatus, compileMsg?: string) {
    if (compileMsg)
      await this.sql`
        UPDATE submissions SET status = ${status}, error_message = ${compileMsg}
        WHERE id = ${this.sid}
      `;
    else
      await this.sql`
        UPDATE submissions SET status = ${status} WHERE id = ${this.sid};
      `;

    await notify(this.sid, this.sql);
  }

  async finalize(
    status: JudgeStatus,
    { score, time, memory }: { score: number; time: number; memory: number },
  ) {
    await this.sql`
      UPDATE submissions
      SET
        score = ${score},
        time_usage = ${time},
        memory_usage = ${memory},
        status = ${status}
      WHERE id = ${this.sid};
    `;
  }

  finalizeSubtask(
    result_id: string,
    { score, time, memory }: { score: number; time: number; memory: number },
  ) {
    return this.sql`
      UPDATE subtask_results
      SET
        score = ${score},
        time_usage = ${time},
        memory_usage = ${memory}
      WHERE id = ${result_id};
    `;
  }

  updateCaseStatus(result_id: string, status: CaseStatus) {
    return this
      .sql`UPDATE case_results SET status = ${status} WHERE id = ${result_id};`;
  }

  async finalizeCase(
    result_id: string,
    status: CaseStatus,
    result: StandardRunResult,
  ) {
    await this.sql`
      UPDATE case_results
      SET
        time_usage = ${result.time},
        memory_usage = ${result.memory},
        user_out = ${sanitizeDbString(result.userOutput)},
        user_error = ${sanitizeDbString(result.userError)},
        system_message = ${result.systemMessage ? sanitizeDbString(result.systemMessage) : null},
        status = ${status}
      WHERE id = ${result_id};
    `;

    await notify(this.sid, this.sql);
  }
}

import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import OSS from "ali-oss";
import { Semaphore } from "async-mutex";
import type { TransactionSql } from "postgres";
import postgres from "postgres";
import { ContestAdapter } from "./adapters/contest.js";
import type { Adapter } from "./adapters/index.js";
import { NormalAdapter } from "./adapters/normal.js";
import { compile } from "./compile.js";
import config from "./config.json" with { type: "json" };
import {
  type CaseStatus,
  type JudgeStatus,
  type SubtaskInfo,
  TaskStatus,
  TestcaseResultType,
} from "./interfaces.js";
import { judgeStandard } from "./judge.js";
import { type Language, getLanguage } from "./languages/index.js";
import logger from "./lib/logger.js";
import { readFileLength } from "./utils.js";

const sem = new Semaphore(4);
const semNumbers = Array.from({ length: 4 }, (_, idx) => idx);

type SubmissionInfo = {
  sid: string;
  test_id: string;

  code: string;
  lang: string;

  time_limit: number;
  memory_limit: number;

  objectNames: string[];
};

const getSubmissionInfo = async (
  data: { id: string; code: string; lang: string; problem_id: string },
  sql: TransactionSql,
): Promise<SubmissionInfo> => {
  const cases = await sql<
    {
      test_id: string;
      time_limit: number;
      memory_limit: number;
      input_file_object_name: string;
      output_file_object_name: string;
    }[]
  >`
    SELECT
      p.test_id, p.time_limit, p.memory_limit,
      input_file_object_name, output_file_object_name
    FROM problems p
    INNER JOIN problem_tests ON problem_tests.id = p.test_id
    INNER JOIN subtasks sub ON sub.test_id = p.test_id
    INNER JOIN test_cases c ON c.subtask_id = sub.id
    WHERE p.id = ${data.problem_id};
`;

  return {
    code: data.code,
    lang: data.lang,
    sid: data.id,
    test_id: cases[0].test_id,
    time_limit: cases[0].time_limit,
    memory_limit: cases[0].memory_limit,
    objectNames: cases.flatMap((c) => [
      c.input_file_object_name,
      c.output_file_object_name,
    ]),
  };
};

const pollSubmission = async (
  sql: TransactionSql,
): Promise<["normal" | "contest", SubmissionInfo]> => {
  for (;;) {
    const [data] = await sql<
      [{ id: string; code: string; lang: string; problem_id: string }?]
    >`
      SELECT id, code, lang, problem_id
      FROM submissions
      WHERE status = 'in_queue'
      LIMIT 1
      FOR UPDATE SKIP LOCKED;
    `;

    if (data) {
      return ["normal", await getSubmissionInfo(data, sql)];
    }

    const [contestData] = await sql<
      [{ id: string; code: string; lang: string; problem_id: string }?]
    >`
      SELECT id, code, lang, problem_id
      FROM contest_submissions
      WHERE status = 'in_queue'
      LIMIT 1
      FOR UPDATE SKIP LOCKED;
    `;

    if (contestData) {
      return ["contest", await getSubmissionInfo(contestData, sql)];
    }

    await new Promise((res) => setTimeout(res, 1000));
  }
};

const downloadTestData = async (
  oss: OSS,
  objectNames: string[],
): Promise<Map<string, string>> => {
  const fileContents = await Promise.all(
    objectNames.map(async (name) => {
      const filename = `${config.tmpDir}/data/${name}`;
      try {
        await stat(filename);
      } catch (_) {
        // file do not exist
        const path = dirname(filename);
        await mkdir(path, { recursive: true });

        await oss.get(name, filename);
      }

      const content = await readFileLength(filename, 50);
      return [name, content] as const;
    }),
  );

  return new Map(fileContents);
};

const judgeSubtask = async (
  {
    lang,
    time_limit,
    memory_limit,
    executableName,
    dataMap,
  }: {
    lang: Language;
    time_limit: number;
    memory_limit: number;
    executableName: string;
    dataMap: Map<string, string>;
  },
  { subtask_id, score, result_id }: SubtaskInfo,
  adapter: Adapter,
) => {
  const cases = await adapter.createCaseResults(subtask_id, result_id, dataMap);

  const caseResults = await Promise.all(
    cases.map((c) =>
      sem.runExclusive(async () => {
        const num = semNumbers.pop();
        if (num === undefined) {
          throw new Error("[Semaphore] num is undefined");
        }

        let result: { status: string; time: number; memory: number } = {
          status: "judgement_failed",
          time: 0,
          memory: 0,
        };

        try {
          result = await judgeCase(
            { time_limit, memory_limit, lang, executableName },
            c,
            num,
            adapter,
          );
        } catch (e) {
          logger.error(e);
        } finally {
          semNumbers.push(num);
        }

        return result;
      }),
    ),
  );

  const time = Math.max(...caseResults.map((c) => c.time));
  const memory = Math.max(...caseResults.map((c) => c.memory));
  const status =
    caseResults.find((s) => s.status !== "accepted")?.status ?? "accepted";

  const acCount = caseResults.filter((c) => c.status === "accepted").length;

  const subtaskScore = (score * acCount) / caseResults.length;
  await adapter.finalizeSubtask(result_id, {
    score: Math.round(subtaskScore),
    time,
    memory,
  });

  return { time, memory, status, subtaskScore };
};

const judgeCase = async (
  {
    lang,
    time_limit,
    memory_limit,
    executableName,
  }: {
    lang: Language;
    time_limit: number;
    memory_limit: number;
    executableName: string;
  },
  {
    result_id,
    input_file_object_name,
    output_file_object_name,
  }: {
    result_id: string;
    input_file_object_name: string;
    output_file_object_name: string;
  },
  num: number,
  adapter: Adapter,
) => {
  await adapter.updateCaseStatus(result_id, "judging");

  const result = await judgeStandard(num, {
    inputData: input_file_object_name,
    answerData: output_file_object_name,
    lang,
    time: time_limit,
    memory: memory_limit,
    userExecutableName: executableName,
  });

  let status: CaseStatus;
  switch (result.result) {
    case TestcaseResultType.Accepted:
      status = "accepted";
      break;

    case TestcaseResultType.WrongAnswer:
      status = "wrong_answer";
      break;

    case TestcaseResultType.TimeLimitExceeded:
      status = "time_limit_exceeded";
      break;

    case TestcaseResultType.MemoryLimitExceeded:
      status = "memory_limit_exceeded";
      break;

    case TestcaseResultType.OutputLimitExceeded:
      status = "output_limit_exceeded";
      break;

    case TestcaseResultType.RuntimeError:
      status = "runtime_error";
      break;

    default:
      status = "judgement_failed";
  }

  await adapter.finalizeCase(result_id, status, result);
  logger.debug("case notify");

  return { status, time: result.time, memory: result.memory };
};

const judgeSubmission = async (
  client: OSS,
  sub: SubmissionInfo,
  adapter: Adapter,
) => {
  logger.info({ sid: sub.sid }, "submission polled");
  const lang = getLanguage(sub.lang);

  if (sub.objectNames.length === 0 || lang === undefined) {
    await adapter.updateStatus("judgement_failed");
    return;
  }

  await adapter.updateStatus("compiling");
  logger.debug("compile notify");

  const codeHash = createHash("sha256")
    .update(sub.code)
    .digest()
    .toString("hex");
  const executableName = `bin-${lang}-${codeHash}`;
  const [compileResult, dataMap] = await Promise.all([
    compile({ code: sub.code, lang, binaryName: executableName }),
    downloadTestData(client, sub.objectNames).catch(
      () => new Map<string, string>(),
    ),
  ]);

  if (dataMap.size === 0) {
    // TODO: file error
    await adapter.updateStatus("judgement_failed");
    logger.error({ error: compileResult.message }, "data download error");
    return;
  }

  if (compileResult.status !== TaskStatus.Done) {
    await adapter.updateStatus("compile_error", compileResult.message);
    logger.warn({ error: compileResult.message }, "compile error");
    return;
  }

  logger.debug(compileResult, "compile success");
  await adapter.updateStatus("judging", compileResult.message);

  const subs = await adapter.createSubtaskResults();
  const subResults = await Promise.all(
    subs.map((task) =>
      judgeSubtask(
        {
          lang,
          time_limit: sub.time_limit,
          memory_limit: sub.memory_limit,
          executableName,
          dataMap,
        },
        task,
        adapter,
      ),
    ),
  );

  const time = Math.max(...subResults.map((s) => s.time));
  const memory = Math.max(...subResults.map((s) => s.memory));
  const status: JudgeStatus =
    (subResults.find((s) => s.status !== "accepted")?.status as JudgeStatus) ??
    "accepted";
  const score = Math.round(
    subResults.map((s) => s.subtaskScore).reduce((a, b) => a + b, 0),
  );

  await adapter.finalize(status, { score, time, memory });
};

const main = async () => {
  const databaseUrl = process.env.DATABASE_URL;
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  const region = process.env.OSS_REGION;
  const bucket = process.env.OSS_BUCKET;

  if (!databaseUrl) throw new Error("env var DATABASE_URL");
  if (!accessKeyId) throw new Error("env var OSS_ACCESS_KEY_ID");
  if (!accessKeySecret) throw new Error("env var OSS_ACCESS_KEY_SECRET");
  if (!region) throw new Error("env var OSS_REGION");
  if (!bucket) throw new Error("env var OSS_BUCKET");

  await Promise.all([
    mkdir(`${config.tmpDir}/data`, { recursive: true }),
    mkdir(`${config.tmpDir}/bin`, { recursive: true }),
    ...semNumbers.flatMap((num) => [
      mkdir(`${config.sandbox.chroot}/sandbox${num}/1`, {
        recursive: true,
      }),
      mkdir(`${config.sandbox.chroot}/sandbox${num}/2`, {
        recursive: true,
      }),
    ]),
  ]);

  const sql = postgres(databaseUrl, { ssl: "prefer" });
  const client = new OSS({ region, accessKeyId, accessKeySecret, bucket });

  logger.info("Judger start.");

  for (;;) {
    const subIdToNotify = await sql
      .begin(async (sql) => {
        const [kind, sub] = await pollSubmission(sql);

        const adapter =
          kind === "normal"
            ? new NormalAdapter(sql, sub.sid, sub.test_id)
            : new ContestAdapter(sql, sub.sid, sub.test_id);

        await judgeSubmission(client, sub, adapter).catch((e) => {
          if (e instanceof postgres.PostgresError) {
            throw e;
          }

          logger.error(e);

          return adapter.updateStatus("judgement_failed");
        });

        return kind === "normal" ? adapter.sid : null;
      })
      .catch(async (e) => {
        // Postgres Error from pollSubmission()
        logger.error(e.message);
        logger.error(e.stack);

        return null;
      });

    if (subIdToNotify) await sql.notify("submission_done", subIdToNotify);
  }
};

main();

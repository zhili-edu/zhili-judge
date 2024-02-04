import type { TransactionSql } from 'postgres';
import { TaskStatus, TestcaseResultType } from './interfaces';
import { compile } from './compile';
import OSS from 'ali-oss';
import { judgeStandard } from './judge';
import { createHash } from 'crypto';
import postgres from 'postgres';
import logger from './lib/logger';
import { Semaphore } from 'async-mutex';
import config from './config.json';
import { mkdir, stat } from 'fs/promises';
import { readFileLength } from './utils';
import { notify } from './lib/notify';

const sem = new Semaphore(4);
const semNumbers = Array.from({ length: 4 }, (_, idx) => idx);

const pollSubmission = async (
    sql: TransactionSql,
): Promise<{
    code: string;
    lang: string;
    sid: string;
    test_id: string;
    time_limit: number;
    memory_limit: number;
    objectNames: string[];
}> => {
    while (true) {
        const [data] = await sql<
            [{ id: string; code: string; lang: string; problem_id: string }?]
        >`
            SELECT id, code, lang, problem_id
            FROM submissions
            WHERE status = 'in_queue'
            LIMIT 1
            FOR UPDATE SKIP LOCKED;
        `;

        if (!data) {
            await new Promise((res) => setTimeout(res, 1000));
            continue;
        }

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
    }
};

const downloadTestData = (oss: OSS, objectNames: string[]) =>
    Promise.all(
        objectNames.map((name) =>
            stat(`${config.tmpDir}/data/${name}`)
                .then(
                    () => null,
                    () => oss.get(name, `${config.tmpDir}/data/${name}`),
                )
                .then(() => readFileLength(`${config.tmpDir}/data/${name}`, 50))
                .then(
                    (content) => [name, content] as const,
                    () => [name, ''] as const,
                ),
        ),
    ).then((entries) => new Map(entries));

const createSubtaskResults = async (
    sid: string,
    test_id: string,
    sql: TransactionSql,
): Promise<{ subtask_id: string; score: number; result_id: string }[]> => {
    return sql<{ subtask_id: string; score: number; result_id: string }[]>`
        WITH results AS (
            INSERT INTO subtask_results
                (submission_id, num, score, time_usage, memory_usage, kind)
            SELECT
                ${sid} AS submission_id,
                num,
                0 AS score,
                0 AS time_usage,
                0 AS memory_usage,
                kind
            FROM subtasks
            WHERE test_id = ${test_id}
            RETURNING id, num
        )

        SELECT
            subtasks.id AS subtask_id, subtasks.score,
            results.id AS result_id
        FROM subtasks
        INNER JOIN results USING (num)
        WHERE test_id = ${test_id}
        ORDER BY num ASC;
    `;
};

const judgeSubtask = async (
    {
        sid,
        lang,
        time_limit,
        memory_limit,
        executableName,
        dataMap,
    }: {
        sid: string;
        lang: string;
        time_limit: number;
        memory_limit: number;
        executableName: string;
        dataMap: Map<string, string>;
    },
    {
        subtask_id,
        score,
        result_id,
    }: {
        subtask_id: string;
        score: number;
        result_id: string;
    },
    sql: TransactionSql,
) => {
    const cases = await sql<
        {
            result_id: string;
            input_file_object_name: string;
            output_file_object_name: string;
        }[]
    >`
        WITH file_contents AS (
            SELECT * FROM (VALUES ${sql(Array.from(dataMap.entries()))}) AS t (object_name, content)
        ),

        results AS (
            INSERT INTO case_results
                (subtask_id, num, time_usage, memory_usage, status, user_in, answer_out)
            SELECT
                ${result_id} AS subtask_id,
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
        FROM test_cases
        INNER JOIN results USING (num)
        WHERE subtask_id = ${subtask_id}
        ORDER BY num ASC;
    `;

    const caseResults = await Promise.all(
        cases.map((c) =>
            sem.runExclusive(async () => {
                const num = semNumbers.pop();
                const result = await judgeCase(
                    { sid, time_limit, memory_limit, lang, executableName },
                    c,
                    num,
                    sql,
                );
                semNumbers.push(num);

                return result;
            }),
        ),
    );

    const time = Math.max(...caseResults.map((c) => c.time));
    const memory = Math.max(...caseResults.map((c) => c.memory));
    const status =
        caseResults.find((s) => s.status !== 'accepted')?.status ?? 'accepted';

    const acCount = caseResults.filter((c) => c.status === 'accepted').length;

    const subtaskScore = (score * acCount) / caseResults.length;
    await sql`
        UPDATE subtask_results
        SET score = ${Math.round(subtaskScore)},
        time_usage = ${time},
        memory_usage = ${memory}
        WHERE id = ${result_id};
    `;

    return {
        time,
        memory,
        status,
        subtaskScore,
    };
};

const judgeCase = async (
    {
        sid,
        lang,
        time_limit,
        memory_limit,
        executableName,
    }: {
        sid: string;
        lang: string;
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
    sql: TransactionSql,
) => {
    await sql`
        UPDATE case_results
        SET status = 'judging'
        WHERE id = ${result_id};
    `;

    const { time, memory, userOutput, userError, systemMessage, result } =
        await judgeStandard(num, {
            inputData: input_file_object_name,
            answerData: output_file_object_name,
            lang,
            time: time_limit,
            memory: memory_limit,
            userExecutableName: executableName,
        });

    let status: string;
    switch (result) {
        case TestcaseResultType.Accepted:
            status = 'accepted';
            break;

        case TestcaseResultType.WrongAnswer:
            status = 'wrong_answer';
            break;

        case TestcaseResultType.TimeLimitExceeded:
            status = 'time_limit_exceeded';
            break;

        case TestcaseResultType.MemoryLimitExceeded:
            status = 'memory_limit_exceeded';
            break;

        case TestcaseResultType.RuntimeError:
            status = 'runtime_error';
            break;

        default:
            status = 'judgement_failed';
    }

    await sql`
        UPDATE case_results
        SET time_usage = ${time},
        memory_usage = ${memory},
        user_out = ${userOutput},
        user_error = ${userError},
        system_message = ${systemMessage ?? null},
        status = ${status}
        WHERE id = ${result_id};
    `;

    await notify(sid, sql);
    logger.debug('case notify');

    return { status, time, memory };
};

const main = async () => {
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

    const sql = postgres(process.env.DATABASE_URL, {});

    const client = new OSS({
        region: process.env.OSS_REGION,
        accessKeyId: process.env.OSS_ACCESS_KEY_ID,
        accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
        bucket: process.env.OSS_BUCKET,
    });

    logger.info('Judger start.');

    while (true) {
        await sql
            .begin(async (sql) => {
                const {
                    sid,
                    code,
                    lang,
                    objectNames,
                    test_id,
                    time_limit,
                    memory_limit,
                } = await pollSubmission(sql);
                try {
                    logger.info({ sid }, 'submission polled');

                    if (objectNames.length === 0) {
                        await sql`UPDATE submissions SET status = 'judgement_failed' WHERE id = ${sid};`;
                        await notify(sid, sql);
                        return;
                    }

                    await sql`UPDATE submissions SET status = 'compiling' WHERE id = ${sid};`;
                    await notify(sid, sql);
                    logger.debug('compile notify');

                    const executableName = `bin-${lang}-${createHash('sha256')
                        .update(code)
                        .digest()
                        .toString('hex')}`;
                    const [compileResult, dataMap] = await Promise.all([
                        compile({
                            code,
                            language: lang,
                            binaryName: executableName,
                        }),
                        downloadTestData(client, objectNames).catch(
                            () => new Map<string, string>(),
                        ),
                    ]);

                    if (compileResult.status !== TaskStatus.Done) {
                        await sql`UPDATE submissions SET status = 'compile_error', error_message = ${compileResult.message} WHERE id = ${sid}`;
                        await notify(sid, sql);
                        logger.warn(
                            { error: compileResult.message },
                            'compile error',
                        );
                        return;
                    }
                    if (dataMap.size === 0) {
                        // TODO: file error
                        await sql`UPDATE submissions SET status = 'judgement_failed' WHERE id = ${sid}`;
                        await notify(sid, sql);
                        logger.error(
                            { error: compileResult.message },
                            'data download error',
                        );
                        return;
                    }

                    logger.debug(compileResult, 'compile success');
                    await sql`
                        UPDATE submissions
                        SET status = 'judging'
                        ${compileResult.message ? sql`, error_message = ${compileResult.message}` : sql``}
                        WHERE id = ${sid};
                    `;

                    const subs = await createSubtaskResults(sid, test_id, sql);
                    const subResults = await Promise.all(
                        subs.map((sub) =>
                            judgeSubtask(
                                {
                                    sid,
                                    lang,
                                    time_limit,
                                    memory_limit,
                                    executableName,
                                    dataMap,
                                },
                                sub,
                                sql,
                            ),
                        ),
                    );

                    const time = Math.max(...subResults.map((s) => s.time));
                    const memory = Math.max(...subResults.map((s) => s.memory));
                    const status =
                        subResults.find((s) => s.status !== 'accepted')
                            ?.status ?? 'accepted';
                    const score = Math.round(
                        subResults
                            .map((s) => s.subtaskScore)
                            .reduce((a, b) => a + b, 0),
                    );

                    await sql`
                        UPDATE submissions
                        SET score = ${score},
                        time_usage = ${time},
                        memory_usage = ${memory},
                        status = ${status}
                        WHERE id = ${sid};
                    `;
                    await notify(sid, sql);
                    logger.debug('done notify');
                } catch (e) {
                    logger.error(e);

                    await sql`UPDATE submissions SET status = 'judgement_failed' WHERE id = ${sid};`;
                }
            })
            .catch((e) => {
                logger.error(e.message);
                logger.error(e.stack);
            });
    }
};

main();

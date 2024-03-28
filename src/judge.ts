import crypto from 'crypto';
import mainLogger from './lib/logger';
import { rename, copyFile } from 'fs/promises';

import { SandboxStatus } from 'simple-sandbox';
import {
    TestcaseResultType,
    StandardRunTask,
    StandardRunResult,
} from './interfaces.js';
import { createEmptyDir, readFileLength } from './utils.js';
import config from './config.json';
import { runProgram, runDiff } from './run.js';
import { signals } from './signals.js';

const JUDGE_FAIL: StandardRunResult = {
    time: 0,
    memory: 0,
    userOutput: '',
    userError: '',

    systemMessage: null,
    result: TestcaseResultType.JudgementFailed,
};

export async function judgeStandard(
    num: number,
    task: StandardRunTask,
): Promise<StandardRunResult> {
    const logger = mainLogger.child({ num });

    logger.debug('Standard judge task...', task);

    const workingDir = `${config.tmpDir}/work/${num}/data`;
    const spjWorkingDir = `${config.tmpDir}/work/${num}/data-spj`;

    logger.debug('Creating directories...');
    await Promise.all([
        createEmptyDir(workingDir),
        createEmptyDir(spjWorkingDir),
    ]);

    const stdinFile = `${crypto.randomBytes(5).toString('hex')}.in`;
    const stdoutFile = `${crypto.randomBytes(5).toString('hex')}.out`;
    const stderrFile = `${crypto.randomBytes(5).toString('hex')}.err`;

    // Copy input file to workingDir
    try {
        logger.debug(
            {
                from: `${config.tmpDir}/data/${task.inputData}`,
                to: `${workingDir}/${stdinFile}`,
            },
            'Copying input file...',
        );
        await copyFile(
            `${config.tmpDir}/data/${task.inputData}`,
            `${workingDir}/${stdinFile}`,
        );
    } catch (e) {
        logger.error(e);

        return JUDGE_FAIL;
    }

    logger.debug('Running user program...');
    const [resultPromise] = await runProgram(
        num,
        task.lang,
        `${config.tmpDir}/bin/${task.userExecutableName}`,
        workingDir,
        task.time,
        task.memory * 1024 * 1024,
        stdinFile,
        stdoutFile,
        stderrFile,
    );

    const runResult = await resultPromise;
    logger.trace(runResult, 'Run result');

    if (runResult.outputLimitExceeded) {
        return JUDGE_FAIL;
    }

    const time = Math.round(runResult.result.time / 1e6);
    const memory = Math.round(runResult.result.memory / 1024);
    const [userOutput, userError] = await Promise.all([
        readFileLength(
            `${workingDir}/${stdoutFile}`,
            config.worker.dataDisplayLimit,
        ),
        readFileLength(
            `${workingDir}/${stderrFile}`,
            config.worker.stderrDisplayLimit,
        ),
    ]);

    if (runResult.result.status !== SandboxStatus.OK) {
        let status: TestcaseResultType;
        let message: string | null = null;

        switch (runResult.result.status) {
            case SandboxStatus.TimeLimitExceeded:
                status = TestcaseResultType.TimeLimitExceeded;
                break;

            case SandboxStatus.MemoryLimitExceeded:
                status = TestcaseResultType.MemoryLimitExceeded;
                break;

            case SandboxStatus.RuntimeError:
                status = TestcaseResultType.RuntimeError;
                message = `Killed: ${signals[runResult.result.code]}`;
                break;

            default:
                status = TestcaseResultType.JudgementFailed;
        }

        return {
            time,
            memory,
            userOutput,
            userError,
            result: status,
            systemMessage: message,
        };
    }

    const message = `Exited with return code ${runResult.result.code}`;

    logger.debug(`Copying files for diff`);
    try {
        await Promise.all([
            rename(`${workingDir}/${stdoutFile}`, `${spjWorkingDir}/user_out`),

            copyFile(
                `${config.tmpDir}/data/${task.answerData}`,
                `${spjWorkingDir}/answer`,
            ),
        ]);
    } catch (e) {
        return JUDGE_FAIL;
    }

    logger.debug(`Running diff`);
    const diffResult = await runDiff(num, spjWorkingDir, 'user_out', 'answer');
    logger.trace(diffResult, 'diff result');

    return {
        time,
        memory,
        userOutput,
        userError,
        systemMessage: message,
        result: diffResult.pass
            ? TestcaseResultType.Accepted
            : TestcaseResultType.WrongAnswer,
    };
}

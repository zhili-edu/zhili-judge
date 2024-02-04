import crypto from 'crypto';
import path from 'path';
import mainLogger from './lib/logger';
import { inspect } from 'util';
import { rename, copyFile } from 'fs/promises';

import { SandboxStatus } from 'simple-sandbox';
import {
    TestcaseResultType,
    StandardRunTask,
    StandardRunResult,
} from './interfaces.js';
import { createOrEmptyDir, readFileLength } from './utils.js';
import config from './config.json';
import { runProgram, runDiff } from './run.js';
import { signals } from './signals.js';
import { getLanguage } from './languages';

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
        createOrEmptyDir(workingDir),
        createOrEmptyDir(spjWorkingDir),
    ]);

    let stdinRedirectionName,
        inputFileName,
        stdoutRedirectionName,
        outputFileName;

    const tempErrFile = crypto.randomBytes(5).toString('hex') + '.err';

    if (task.fileIOInput != null) {
        // problem with fileIO
        inputFileName = task.fileIOInput;
        stdinRedirectionName = null;
    } else {
        // problem with input
        if (task.inputData != null) {
            stdinRedirectionName = inputFileName =
                crypto.randomBytes(5).toString('hex') + '.in';
        } else {
            stdinRedirectionName = inputFileName = null;
        }
    }

    if (task.fileIOOutput != null) {
        outputFileName = task.fileIOOutput;
        stdoutRedirectionName = null;
    } else {
        stdoutRedirectionName = outputFileName =
            crypto.randomBytes(10).toString('hex') + '.out';
    }

    // Copy input file to workingDir
    if (task.inputData != null) {
        logger.debug(
            {
                from: `${config.tmpDir}/data/${task.inputData}`,
                to: `${workingDir}/${inputFileName}`,
            },
            'Copying input file...',
        );
        try {
            await copyFile(
                `${config.tmpDir}/data/${task.inputData}`,
                `${workingDir}/${inputFileName}`,
            );
        } catch (e) {
            return {
                time: 0,
                memory: 0,
                userOutput: '',
                userError: '',
                scoringRate: 0,
                spjMessage: '',
                result: TestcaseResultType.FileError,
            };
        }
    }

    logger.debug('Running user program...');
    const [resultPromise] = await runProgram(
        num,
        getLanguage(task.lang),
        `${config.tmpDir}/bin/${task.userExecutableName}`,
        workingDir,
        task.time,
        task.memory * 1024 * 1024,
        stdinRedirectionName,
        stdoutRedirectionName,
        tempErrFile,
    );
    const runResult = await resultPromise;

    logger.trace(runResult, 'Run result');

    const time = Math.round(runResult.result.time / 1e6),
        memory = runResult.result.memory / 1024;

    let status: TestcaseResultType = null,
        message = null;

    if (runResult.outputLimitExceeded) {
        status = TestcaseResultType.OutputLimitExceeded;
    } else if (runResult.result.status === SandboxStatus.TimeLimitExceeded) {
        status = TestcaseResultType.TimeLimitExceeded;
    } else if (runResult.result.status === SandboxStatus.MemoryLimitExceeded) {
        status = TestcaseResultType.MemoryLimitExceeded;
    } else if (runResult.result.status === SandboxStatus.RuntimeError) {
        message = `Killed: ${signals[runResult.result.code]}`;
        status = TestcaseResultType.RuntimeError;
    } else if (runResult.result.status !== SandboxStatus.OK) {
        message =
            'Warning: corrupt sandbox result ' + inspect(runResult.result);
        status = TestcaseResultType.RuntimeError;
    } else {
        message = `Exited with return code ${runResult.result.code}`;
    }

    const [userOutput, userError] = await Promise.all([
        readFileLength(
            path.join(workingDir, outputFileName),
            config.worker.dataDisplayLimit,
        ),
        readFileLength(
            path.join(workingDir, tempErrFile),
            config.worker.stderrDisplayLimit,
        ),
    ]);

    try {
        await rename(
            path.join(workingDir, outputFileName),
            path.join(spjWorkingDir, 'user_out'),
        );
    } catch (e) {
        if (
            e.code === 'ENOENT' &&
            runResult.result.status === SandboxStatus.OK &&
            !runResult.outputLimitExceeded
        ) {
            status = TestcaseResultType.FileError;
        }
    }

    const partialResult = {
        time,
        memory,
        userOutput,
        userError,
        systemMessage: message,
    };
    if (status !== null) {
        return {
            scoringRate: 0,
            spjMessage: null,
            result: status,
            ...partialResult,
        };
    }

    // copy answerFile to workingDir
    if (task.answerData != null)
        try {
            await copyFile(
                `${config.tmpDir}/data/${task.answerData}`,
                `${spjWorkingDir}/answer`,
            );
        } catch (e) {
            return {
                time: 0,
                memory: 0,
                userOutput: '',
                userError: '',
                scoringRate: 0,
                spjMessage: '',
                result: TestcaseResultType.FileError,
            };
        }

    logger.debug(`Running diff`);
    const diffResult = await runDiff(num, spjWorkingDir, 'user_out', 'answer');
    logger.trace(diffResult, 'diff result');

    return {
        scoringRate: diffResult.pass ? 1 : 0,
        spjMessage: diffResult.message,
        result: diffResult.pass
            ? TestcaseResultType.Accepted
            : TestcaseResultType.WrongAnswer,
        ...partialResult,
    };
}

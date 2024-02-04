import { mkdir, opendir, readFile, rm } from 'fs/promises';
import path from 'path';
import {
    startSandbox,
    getUidAndGidInSandbox,
    type SandboxParameter,
    SandboxStatus,
    type SandboxResult,
} from 'simple-sandbox';
import { getFolderSize as getSize, setWriteAccess } from './utils.js';
import { Language } from './languages/index.js';
import mainLogger from './lib/logger.js';
import config from './config.json';

export interface RunResult {
    outputLimitExceeded: boolean;
    result: SandboxResult;
}

export interface DiffResult {
    pass: boolean;
    message: string;
}

export async function runDiff(
    num: number,
    dataDir: string,
    file1: string,
    file2: string,
): Promise<DiffResult> {
    await setWriteAccess(dataDir, true);
    const tmpPath = `/sandbox${num}/1`,
        outputFileName = 'diff.txt';
    const sandbox = startSandbox({
        ...config.sandbox,
        cgroup: `${config.sandbox.cgroup}${num}`,
        user: getUidAndGidInSandbox(config.sandbox.chroot, config.sandbox.user),
        executable: '/usr/bin/diff',
        parameters: ['/usr/bin/diff', '-Bbq', file1, file2],
        time: config.worker.spjTimeLimit,
        memory: config.worker.spjMemoryLimit * 1024 * 1024,
        process: 2,
        stdin: null,
        stdout: outputFileName,
        stderr: null,
        workingDirectory: tmpPath,
        mounts: [
            {
                src: dataDir,
                dst: tmpPath,
                limit: -1,
            },
        ],
    });
    const sandboxResult = await sandbox.waitForStop();

    if (sandboxResult.status !== SandboxStatus.OK) {
        return {
            pass: false,
            message: `Diff encountered ${SandboxStatus[sandboxResult.status]}`,
        };
    }

    const message = await readFile(path.join(dataDir, outputFileName), 'utf8');
    return { pass: sandboxResult.code === 0, message: message };
}

export async function runProgram(
    num: number,
    language: Language,
    binDir: string,
    dataDir: string,
    time: number,
    memory: number,
    stdinFile?: string | number,
    stdoutFile?: string | number,
    stderrFile?: string | number,
): Promise<[Promise<RunResult>, () => void]> {
    const logger = mainLogger.child({ num });

    await setWriteAccess(binDir, false);
    await setWriteAccess(dataDir, true);

    const dataDir_Sandbox = `/sandbox${num}/1`;
    const binDir_Sandbox = `/sandbox${num}/2`;
    const runConfig = language.run(
        binDir_Sandbox,
        dataDir_Sandbox,
        time,
        memory,
        stdinFile,
        stdoutFile,
        stderrFile,
    );

    const sandboxParam: SandboxParameter = {
        ...config.sandbox,
        ...runConfig,
        cgroup: `${config.sandbox.cgroup}${num}`,
        user: getUidAndGidInSandbox(config.sandbox.chroot, config.sandbox.user),
        mounts: [
            {
                src: binDir,
                dst: binDir_Sandbox,
                limit: 0,
            },
            {
                src: dataDir,
                dst: dataDir_Sandbox,
                limit: -1,
            },
        ],
    };

    logger.trace(sandboxParam);

    const dir = await opendir(dataDir);
    for await (const d of dir) {
        logger.trace(d.name);
    }
    const dir2 = await opendir(binDir);
    for await (const d of dir2) {
        logger.trace(d.name);
    }

    let result: SandboxResult = null;
    const sandbox = startSandbox(sandboxParam);
    return [
        (async () => {
            result = await sandbox.waitForStop();

            let ole = false;
            const outputSize = await getSize(dataDir);
            if (outputSize > config.worker.outputLimit) {
                await rm(dataDir, { recursive: true }).then(() =>
                    mkdir(dataDir),
                );
                ole = true;
            }

            return {
                outputLimitExceeded: ole,
                result: result,
            };
        })(),
        () => {
            sandbox.stop();
        },
    ];
}

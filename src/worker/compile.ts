import path from 'path';
import { writeFile } from 'fs/promises';
import AnsiToHtml from 'ansi-to-html';
import { CompileTask, CompilationResult, TaskStatus } from '../interfaces.js';
import { remove, createOrEmptyDir, setWriteAccess } from './utils.js';
import { getLanguage } from '../languages/index.js';
import {
    startSandbox,
    SandboxStatus,
    getUidAndGidInSandbox,
    type SandboxParameter,
} from 'simple-sandbox';
import { getFolderSize as getSize, readFileLength } from '../utils.js';
import { pushBinary } from './executable.js';
import globalConfig from './config';

const convert = new AnsiToHtml({ escapeXML: true });

export async function compile(task: CompileTask): Promise<CompilationResult> {
    const srcDir = path.join(globalConfig.worker.workingDirectory, `src`);
    const binDir = path.join(globalConfig.worker.workingDirectory, `bin`);
    const tempDir = path.join(globalConfig.worker.workingDirectory, 'temp');
    await Promise.all([
        createOrEmptyDir(srcDir),
        createOrEmptyDir(binDir),
        createOrEmptyDir(tempDir),
    ]);
    await Promise.all([
        setWriteAccess(srcDir, false),
        setWriteAccess(binDir, true),
        setWriteAccess(tempDir, true),
    ]);

    const writeTasks: Promise<void>[] = [];
    if (task.extraFiles) {
        for (const f of task.extraFiles) {
            writeTasks.push(
                writeFile(path.join(srcDir, f.name), f.content, {
                    encoding: 'utf8',
                }),
            );
        }
    }

    const language = getLanguage(task.language);
    const srcPath = path.join(srcDir, language.sourceFileName);
    writeTasks.push(writeFile(srcPath, task.code, { encoding: 'utf8' }));
    await Promise.all(writeTasks);

    const srcDir_Sandbox = '/sandbox/1';
    const binDir_Sandbox = '/sandbox/2';
    const compileConfig = language.compile(
        `${srcDir_Sandbox}/${language.sourceFileName}`,
        binDir_Sandbox,
        globalConfig.worker.doNotUseX32ABI,
    );

    const sandboxParam: SandboxParameter = {
        ...globalConfig.sandbox,
        ...compileConfig,
        user: getUidAndGidInSandbox(
            globalConfig.sandbox.chroot,
            globalConfig.sandbox.user,
        ),
        mounts: [
            {
                src: srcDir,
                dst: srcDir_Sandbox,
                limit: 0,
            },
            {
                src: binDir,
                dst: binDir_Sandbox,
                limit: -1,
            },
            {
                src: tempDir,
                dst: '/tmp',
                limit: -1,
            },
        ],
    };

    try {
        const sandbox = startSandbox(sandboxParam);
        const sandboxResult = await sandbox.waitForStop();

        // If the compiler exited
        if (sandboxResult.status === SandboxStatus.OK) {
            // If the compiler did not return an error
            if (sandboxResult.code === 0) {
                const outputSize = await getSize(binDir);
                // If the output is too long
                if (outputSize > language.binarySizeLimit) {
                    return {
                        status: TaskStatus.Failed,
                        message: `Your source code compiled to ${outputSize} bytes which is too big, too thick, too long for us..`,
                    };
                } // Else OK!
            } else {
                // If compilation error
                return {
                    status: TaskStatus.Failed,
                    message: convert.toHtml(
                        await readFileLength(
                            path.join(binDir, compileConfig.messageFile),
                            globalConfig.worker.compilerMessageLimit,
                        ),
                    ),
                };
            }
        } else {
            return {
                status: TaskStatus.Failed,
                message: (
                    `A ${
                        SandboxStatus[sandboxResult.status]
                    } encountered while compiling your code.\n\n` +
                    (await readFileLength(
                        binDir + '/' + compileConfig.messageFile,
                        globalConfig.worker.compilerMessageLimit,
                    ))
                ).trim(),
            };
        }

        await pushBinary(task.binaryName, language, task.code, binDir);
        return { status: TaskStatus.Done };
    } finally {
        await Promise.all([remove(binDir), remove(srcDir)]);
    }
}

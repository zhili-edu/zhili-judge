import type { Language } from '../../languages/index.js';
import { runTask } from '../../lib/rmq-common.js';
import {
    type CompilationResult,
    type TestcaseResult,
    RPCTaskType,
    TaskStatus,
    type CompileTask,
    type FileContent,
    redisMetadataSuffix,
} from '../../interfaces.js';
import { logger } from '../../lib/winston-common';
import { redis, redlock, amqp } from '../index.js';
import { createHash } from 'crypto';

const codeFingerprint = (code: string, language: string): string =>
    `src-${language}${createHash('sha256')
        .update(code)
        .digest()
        .toString('hex')}`;

export async function compile(
    code: string,
    language: Language,
    extraFiles: FileContent[] = [],
    priority: number,
): Promise<[string, CompilationResult]> {
    const fingerprint = codeFingerprint(code, language.name);
    logger.debug(`Compiling code, fingerprint = ${fingerprint}`);

    return redlock.using([fingerprint], 5000, {}, async () => {
        try {
            if (await redis.exists(`${fingerprint}${redisMetadataSuffix}`)) {
                logger.debug('Binary already exists. Exiting');
                return [fingerprint, { status: TaskStatus.Done }];
            } else {
                const task: CompileTask = {
                    code: code,
                    language: language.name,
                    extraFiles: extraFiles,
                    binaryName: fingerprint,
                };
                return [
                    fingerprint,
                    await runTask(
                        amqp,
                        { type: RPCTaskType.Compile, task: task },
                        priority,
                    ),
                ];
            }
        } catch (e) {
            logger.error(e);
        }
    });
}

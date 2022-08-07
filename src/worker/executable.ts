import tar from 'tar';
import { rmdir, stat, mkdir } from 'fs/promises';
import { encode, decode } from 'msgpack-lite';
import { logger } from '../lib/winston-common.js';
import { redis, redlock } from './index.js';
import { getBufferThrow } from '../lib/redis.js';
import { streamToBuffer } from '../utils.js';
import globalConfig from './config.js';
import { getLanguage, Language } from '../languages/index.js';
import { redisBinarySuffix, redisMetadataSuffix } from '../interfaces.js';
import path from 'path';

interface BinaryMetadata {
    language: string;
    code: string;
}

export async function pushBinary(
    name: string,
    language: Language,
    code: string,
    path: string,
): Promise<void> {
    logger.verbose(`Pushing binary ${name}, creating tar archive...`);
    const binary = await streamToBuffer(
        tar.create(
            {
                gzip: true,
                cwd: path,
                portable: true,
            },
            ['.'],
        ),
    );
    const data: BinaryMetadata = {
        language: language.name,
        code: code,
    };

    // TODO: multiple set
    await redis.setBuffer(name + redisBinarySuffix, binary, 'GET');
    await redis.setBuffer(name + redisMetadataSuffix, encode(data), 'GET');
}

// Return value: [path, language, code]
// TODO: rej when fetching failed.
export async function fetchBinary(
    name: string,
): Promise<[string, Language, string]> {
    logger.verbose(`Fetching binary ${name}...`);
    await stat(globalConfig.sandbox.binaryDirectory).catch(() =>
        mkdir(globalConfig.sandbox.binaryDirectory),
    );
    const targetName = path.join(globalConfig.sandbox.binaryDirectory, name);
    const lockFileName = path.join(
        globalConfig.sandbox.binaryDirectory,
        `${name}-get.lock`,
    );

    const metadata = decode(
        await getBufferThrow(redis, name + redisMetadataSuffix),
    ) as BinaryMetadata;

    logger.debug(`Acquiring lock ${lockFileName}...`);
    await redlock.using([lockFileName], 5000, {}, async () => {
        logger.debug(`Got lock for ${name} using redlock.`);
        try {
            await stat(targetName).then(
                () => {
                    logger.debug(`Work ${name} done by others...`);
                },
                async () => {
                    logger.debug(`Doing work: fetching binary for ${name} ...`);
                    await stat(targetName).catch(() => mkdir(targetName));
                    const binary = await getBufferThrow(
                        redis,
                        name + redisBinarySuffix,
                    );
                    logger.debug(
                        `Decompressing binary (size=${binary.length})...`,
                    );
                    await new Promise((res, rej) => {
                        const s = tar.extract({
                            cwd: targetName,
                        });
                        s.on('error', rej);
                        s.on('close', res);
                        s.write(binary);
                        s.end();
                    });
                },
            );
            // if (await pathExists(targetName)) {
            // } else {
            // }
        } catch (e) {
            logger.error('Fetching binary failed.');
            logger.error(e);
            await rmdir(targetName);
        }
    });
    logger.silly(`Fetch done, targetName: ${targetName}`);
    return [targetName, getLanguage(metadata.language), metadata.code];
}

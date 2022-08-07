import { existsSync, readFileSync } from 'fs';
import { readFile, open, FileHandle } from 'fs/promises';
import { promisify } from 'util';
import type { Readable } from 'stream';
import { exec, execFile } from 'child_process';
import { logger } from './lib/winston-common';
import type { JsonObject } from 'type-fest';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function getSystemExecutable(program: string) {
    return existsSync(`/bin/${program}`)
        ? `/bin/${program}`
        : `/usr/bin/${program}`;
}

export const readJSON = (path: string): JsonObject => {
    logger.silly('Reading JSON from ' + path);
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return {};
    }
};

export async function emptyDir(dirName: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
        try {
            await execAsync(
                `${getSystemExecutable('find')} . -mindepth 1 -delete`,
                { cwd: dirName },
            );
            return;
        } catch (e) {
            if (i === 9) throw e;

            await new Promise((r) => setTimeout(r, 500));
        }
    }
}

export async function remove(filename: string): Promise<void> {
    await execFileAsync(getSystemExecutable('rm'), ['-rf', '--', filename]);
}

export async function getFolderSize(dirName: string): Promise<number> {
    const result = await execAsync(
        `${getSystemExecutable('du')} -sb . | ${getSystemExecutable(
            'cut',
        )} -f1`,
        { cwd: dirName },
    );
    return Number(result.stdout) || 0;
}

export function streamToBuffer(source: Readable): Promise<Buffer> {
    return new Promise((res, rej) => {
        const bufs = [];
        source.on('data', (d) => {
            bufs.push(d);
        });
        source.on('end', () => {
            res(Buffer.concat(bufs));
        });
        source.on('error', (err) => {
            rej(err);
        });
    });
}

export function cloneObject<T>(src: T): T {
    return Object.assign({}, src);
}

export function fileTooLongPrompt(
    actualSize: number,
    bytesRead: number,
): string {
    const omitted = actualSize - bytesRead;
    return `<${omitted} byte${omitted != 1 ? 's' : ''} omitted>`;
}

export async function tryReadFile(
    path: string,
    encoding = 'utf8',
): Promise<string> {
    let fileContent = null;
    try {
        fileContent = await readFile(path, 'utf8');
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw e;
        }
    }
    return fileContent;
}

export function readBufferLength(
    buf: Buffer,
    lengthLimit: number,
    appendPrompt = fileTooLongPrompt,
): string {
    let content = buf.toString('utf8', 0, lengthLimit);
    if (buf.length > lengthLimit) {
        content += '\n' + appendPrompt(buf.length, lengthLimit);
    }
    return content;
}

export async function readFileLength(
    path: string,
    lengthLimit: number,
    appendPrompt = fileTooLongPrompt,
): Promise<string | null> {
    let file: FileHandle;
    try {
        file = await open(path);

        // file = await fse.open(path, 'r');
        // const actualSize = (await fse.stat(path)).size;
        const actualSize = (await file.stat()).size;
        // const buf = new Buffer(Math.min(actualSize, lengthLimit));
        const buf = Buffer.alloc(Math.min(actualSize, lengthLimit));
        const { bytesRead } = await file.read(buf, 0, buf.length, 0);

        // const bytesRead = (await fse.read(
        //     file,
        //     buf,
        //     0,
        //     buf.length,
        //     0,
        // )) as any as number;

        let ret = buf.toString('utf8', 0, bytesRead);
        if (bytesRead < actualSize) {
            ret += '\n' + appendPrompt(actualSize, bytesRead);
        }

        return ret;
    } catch (e) {
        return null;
    } finally {
        await file?.close();
    }
}

export function filterPath(src: string): string {
    src = src.toString();
    const replaceList = ['..'];
    let orig;
    let cur = src;
    do {
        orig = cur;
        for (const s of replaceList) {
            cur = cur.replace(s, '');
        }
    } while (cur != orig);
    return cur;
}

// By Pisces
function extractNumerals(s: string): number[] {
    return (s.match(/\d+/g) || []).map((x) => parseInt(x));
}

export function compareStringByNumber(a: string, b: string) {
    const acmp = extractNumerals(a),
        bcmp = extractNumerals(b);
    for (let i = 0; i < Math.min(acmp.length, bcmp.length); i++) {
        if (acmp[i] > bcmp[i]) return 1;
        else if (acmp[i] < bcmp[i]) return -1;
    }
    return a > b ? 1 : -1;
}

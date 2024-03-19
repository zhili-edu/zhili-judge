import { existsSync } from 'fs';
import { readFile, open, type FileHandle, mkdir, rm } from 'fs/promises';
import { promisify } from 'util';
import { exec, execFile } from 'child_process';
import { getUidAndGidInSandbox } from 'simple-sandbox';
import globalConfig from './config.json';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function getSystemExecutable(program: string) {
    return existsSync(`/bin/${program}`)
        ? `/bin/${program}`
        : `/usr/bin/${program}`;
}

export const createOrEmptyDir = async (path: string): Promise<void> => {
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { recursive: true });
};

export async function setWriteAccess(
    dirName: string,
    writeAccess: boolean,
): Promise<void> {
    const user = getUidAndGidInSandbox(
        globalConfig.sandbox.chroot,
        globalConfig.sandbox.user,
    );
    const uid = writeAccess ? user.uid : process.getuid();
    await Promise.all([
        execFileAsync('/bin/chmod', ['-R', '755', '--', dirName]),
        execFileAsync('/bin/chown', ['-R', `${uid}:${uid}`, '--', dirName]),
    ]);
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

export function fileTooLongPrompt(
    actualSize: number,
    bytesRead: number,
): string {
    const omitted = actualSize - bytesRead;
    return `<${omitted} byte${omitted != 1 ? 's' : ''} omitted>`;
}

export async function tryReadFile(
    path: string,
    encoding: BufferEncoding = 'utf8',
): Promise<string> {
    let fileContent = null;
    try {
        fileContent = await readFile(path, encoding);
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

        const actualSize = (await file.stat()).size;

        const buf = Buffer.alloc(Math.min(actualSize, lengthLimit));
        const { bytesRead } = await file.read(buf, 0, buf.length, 0);

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

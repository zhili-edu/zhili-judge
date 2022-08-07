import { mkdir, stat } from 'fs/promises';
import { ExecParam } from '../languages/index.js';
import { cloneObject } from '../utils.js';
import {
    type SandboxParameter,
    type MountInfo,
    getUidAndGidInSandbox,
} from 'simple-sandbox';
import { emptyDir } from '../utils.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import globalConfig from './config';

export * from '../utils.js';

const execFileAsync = promisify(execFile);

export async function setWriteAccess(
    dirName: string,
    writeAccess: boolean,
): Promise<void> {
    const user = getUidAndGidInSandbox(
        globalConfig.sandbox.chroot,
        globalConfig.sandbox.user,
    );
    const uid = writeAccess ? user.uid : process.getuid(),
        gid = writeAccess ? user.gid : process.getgid();
    await Promise.all([
        execFileAsync('/bin/chmod', ['-R', '755', '--', dirName]),
        execFileAsync('/bin/chown', ['-R', `${uid}:${uid}`, '--', dirName]),
    ]);
}

export const createOrEmptyDir = async (path: string): Promise<void> =>
    stat(path).then(
        () => emptyDir(path),
        () => mkdir(path),
    );

export const tryEmptyDir = async (path: string) => {
    try {
        await emptyDir(path);
    } catch (e) {}
};

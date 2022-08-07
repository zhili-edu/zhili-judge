import Client from 'ioredis';
import Redlock from 'redlock';
import { Redis } from 'ioredis';

const lockTTL = 1000;
/*export async function getCompileLock(
    redlock: Redlock,
    name: string,
): Promise<() => Promise<void>> {
    const lockName = `compile-${name}`;
    redlock.using([lockName], duration, settings)

    // const lock = await redlock.lock(lockName, lockTTL);
    // const token = setInterval(async () => {
    //     await lock.extend(lockTTL);
    // }, lockTTL * 0.7);

    // return async () => {
    //     clearInterval(token);
    //     await lock.unlock();
    // };
}*/

export const getThrow = async (redis: Redis, key: string): Promise<string> => {
    const val = await redis.get(key);
    if (val == null) throw new Error(`Redis record ${key} unavailable.`);
    return val;
};

export const getBufferThrow = async (
    redis: Redis,
    key: string,
): Promise<Buffer> => {
    const val = await redis.getBuffer(key);
    if (val == null) throw new Error(`Redis record ${key} unavailable.`);
    return val;
};

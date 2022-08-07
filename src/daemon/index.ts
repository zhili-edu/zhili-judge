import { logger } from '../lib/winston-common.js';
import EventWebSocket from '../lib/websocket.js';
import Redlock from 'redlock';
import { inspect } from 'util';
import Mongo from '../lib/mongo.js';
import { judge } from './judge/index.js';
import { SerializedBuffer } from '../interfaces.js';
import {
    JudgeStateStatus,
    type JudgeTask,
    getStatus,
    setStatus,
    getScore,
} from './interface/judgeTask.js';
import { getJSDocReadonlyTag } from 'typescript';
import globalConfig from './config';
import { default as Redis } from 'ioredis';
import { AMQPClient } from '@cloudamqp/amqp-client';

export let mongo: Mongo;
export let redis: Redis;
export let redlock: Redlock;
export let amqp: AMQPClient;

const taskHandler = async (socket: EventWebSocket, task: JudgeTask) => {
    logger.verbose(`TaskHandler handling task ${task.taskId}`);
    // TODO: task.extraData
    /*if (task.extraData) {
            const extraData: SerializedBuffer = task.extraData as any as SerializedBuffer;
            if (extraData.type === "Buffer") task.extraData = new Buffer(extraData.data);
        }*/

    try {
        await judge(task, (task: JudgeTask) => reportProgress(socket, task));
        console.log('after daemon index', task);
    } catch (err) {
        logger.warn(`Judge error!!! TaskId: ${task.taskId}`, err);
        setStatus(task.judgeState, JudgeStateStatus.SystemError);
        task.judgeState.errorMessage = `An error occurred.\n${err.toString()}`;
    }

    logger.verbose('Done judging.');
    getStatus(task.judgeState);
    getScore(task);

    reportProgress(socket, task);
    reportResult(socket);
};

const main = async () => {
    logger.info('Daemon starts.');

    mongo = new Mongo(
        globalConfig.mongoDB.url,
        globalConfig.mongoDB.name,
        globalConfig.mongoDB.username,
        globalConfig.mongoDB.password,
    );

    logger.info('Connecting to MongoDB...');
    await mongo.connect();

    redis = new Redis(globalConfig.redisUrl);
    redlock = new Redlock([redis]);

    logger.info('Connecting to RabbitMQ...');
    amqp = new AMQPClient(globalConfig.rabbitMQ.url);
    await amqp.connect();

    logger.info('Connecting to Remote...');
    const socket = new EventWebSocket(globalConfig.server.url);

    socket.on('close', () => socket.off('onTask'));
    socket.on('error', () => socket.off('onTask'));

    socket.on('open', async () => {
        logger.info('Start consuming the queue...');
        let loopResult: boolean;
        do {
            logger.verbose('waitForTask looping');
            loopResult = await new Promise<void>((res, rej) => {
                socket.once('onTask', async (payload: any) => {
                    logger.silly('Daemon onTask');

                    if (socket.readyState !== 1) rej();

                    try {
                        socket.emit('ackonTask', {});
                        await taskHandler(socket, payload as JudgeTask);
                        res();
                    } catch (e) {
                        rej(e);
                    }
                });

                if (socket.readyState !== 1) rej();
                logger.debug('Sending waitForTask to remote...');
                try {
                    socket.emit('waitForTask', globalConfig.server.token);
                } catch (e) {
                    rej(e);
                }
            }).then(
                () => true,
                () => false,
            );
            logger.debug(`waitForTask loop result: ${loopResult}`);
        } while (loopResult);
    });
};

export const reportProgress = (socket: EventWebSocket, task: JudgeTask) => {
    logger.verbose('Reporting progress...');
    socket.emit('reportProgress', {
        token: globalConfig.server.token,
        judgeTask: task,
    });
};

export const reportResult = (socket: EventWebSocket) => {
    logger.verbose('Reporting result...');
    socket.emit('reportResult', globalConfig.server.token);
};

main().catch((e) => {
    logger.error('Daemon Error!');
    logger.error(inspect(e));
});

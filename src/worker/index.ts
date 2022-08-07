import { default as Redis } from 'ioredis';
import { AMQPClient } from '@cloudamqp/amqp-client';
import { inspect } from 'util';
import { waitForTask } from '../lib/rmq-common.js';
import Mongo from '../lib/mongo.js';
import { RPCTaskType } from '../interfaces.js';
import { compile } from './compile.js';
import {
    judgeStandard,
    // judgeAnswerSubmission,
    // judgeInteraction
} from './judge.js';
import globalConfig from './config';
import Redlock from 'redlock';
import { logger } from '../lib/winston-common.js';

export let mongo: Mongo;
export let redis: Redis;
export let redlock: Redlock;
export let amqp: AMQPClient;

const main = async () => {
    mongo = new Mongo(
        globalConfig.mongoDB.url,
        globalConfig.mongoDB.name,
        globalConfig.mongoDB.username,
        globalConfig.mongoDB.password,
    );

    logger.info('Runner starts.');
    await mongo.connect();
    logger.info('Start consuming the queue.');

    amqp = new AMQPClient(globalConfig.rabbitMQ.url);
    await amqp.connect();
    redis = new Redis(globalConfig.redisUrl);

    redlock = new Redlock([redis]);

    await waitForTask(amqp, async (task) => {
        logger.debug(`Handling task, type: ${task.type}`);
        logger.silly(inspect(task));

        if (task.type === RPCTaskType.Compile) {
            return await compile(task.task);
        } else if (task.type === RPCTaskType.RunStandard) {
            return await judgeStandard(task.task);
        } /* else if (task.type === RPCTaskType.RunSubmitAnswer) {
            return await judgeAnswerSubmission(task.task);
        }else if (task.type === RPCTaskType.RunInteraction) {
            return await judgeInteraction(task.task);
        } */ else {
            logger.warn('Task type unsupported');
            throw new Error(`Task type ${task.type} not supported!`);
        }
    });
};

main().then(
    () => logger.verbose('Runner task done.'),
    (e) => logger.error(e),
);

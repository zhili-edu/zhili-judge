import { AMQPClient, type AMQPMessage } from '@cloudamqp/amqp-client';
import { logger } from './winston-common.js';
import { decode, encode } from 'msgpack-lite';
import globalCfg from '../config.json';
import { RPCReply, RPCReplyType, RPCRequest } from '../interfaces.js';
import { inspect } from 'util';
import { randomBytes, randomUUID } from 'crypto';

const connect = async (): Promise<AMQPClient> => {
    logger.verbose('Connecting to RabbitMQ...');
    // const amqpConnection = await connectAmqp(globalCfg.rabbitMQ.url);
    const client = new AMQPClient(globalCfg.rabbitMQ.url);
    await client.connect();
    // const conn = await client.connect();

    /*amqpConnection.on('error', (err) => {
        logger.error(`RabbitMQ connection failure: ${err.toString()}`);
        logger.info('Cleaning up...');
        amqpConnection.close();
        process.exit(1);
    });*/

    return client;
};

// for daemon
export const runTask = async (
    client: AMQPClient,
    task: RPCRequest,
    priority: number,
    started?: () => void,
): Promise<any> => {
    const correlationId = randomUUID();

    logger.verbose(
        `Sending task ${inspect(
            task,
        )} to run, with ID ${correlationId} and priority ${priority}`,
    );

    const chan = await client.channel();
    // TODO: properties
    const taskQueue = await chan.queue(globalCfg.rabbitMQ.queueName, {
        durable: true,
    });
    const replyQueue = await chan.queue(
        `reply.${randomBytes(20).toString('hex')}`,
        { autoDelete: true },
    );

    const replyPromise = new Promise((res, rej) => {
        // automatically send ack to reply message
        replyQueue.subscribe({ noAck: true }, (msg) => {
            const reply = decode(msg.body) as RPCReply;
            logger.verbose(
                `Task ${correlationId} got reply: ${inspect(reply)}`,
            );

            if (reply.type === RPCReplyType.Started) {
                if (started) started();
            } else {
                chan.close().then(
                    () => {
                        if (reply.type === RPCReplyType.Finished) {
                            res(reply.result);
                        } else {
                            rej(new Error(reply.error));
                        }
                    },
                    (err) => {
                        logger.error(`Failed to close RabbitMQ channel`, err);
                        rej(err);
                    },
                );
            }
        });
    });

    await taskQueue.publish(encode(task), {
        correlationId,
        replyTo: replyQueue.name,
    });

    return replyPromise;
};

// for runner
export const waitForTask = async (
    client: AMQPClient,
    handler: (task: RPCRequest) => Promise<unknown>,
) => {
    const chan = await client.channel();
    await chan.prefetch(1);

    await chan.queueDeclare(globalCfg.rabbitMQ.queueName, {
        durable: true,
    });
    await chan.basicConsume(
        globalCfg.rabbitMQ.queueName,
        { noAck: false },
        async (msg: AMQPMessage) => {
            const correlationId = msg.properties.correlationId;
            const replyQueue = await chan.queue(msg.properties.replyTo, {
                autoDelete: true,
            });
            const req = decode(msg.body) as RPCRequest;

            replyQueue.publish(encode({ type: RPCReplyType.Started }));

            while (true) {
                const res = await handler(req).then(
                    (result) => ({ success: true, result } as const),
                    (error: Error) => ({ success: false, error } as const),
                );

                if (res.success === true) {
                    replyQueue.publish(
                        encode({
                            type: RPCReplyType.Finished,
                            result: res.result,
                        }),
                    );
                    break;
                } else {
                    const errorMessage = `Failed to run task ${
                        msg.properties.correlationId
                    }: ${res.error.toString()}, ${res.error.stack}`;
                    logger.warn(errorMessage);

                    if (
                        errorMessage.includes(
                            'Error: The child process has exited unexpectedly.',
                        ) ||
                        errorMessage.includes(
                            'open(std_input.c_str(), O_RDONLY)',
                        )
                    ) {
                        logger.warn('Retrying...');
                        continue;
                    } else {
                        replyQueue.publish(
                            encode({
                                type: RPCReplyType.Error,
                                error: res.error.toString(),
                            }),
                        );
                        break;
                    }
                }
            }

            await msg.ack();
        },
    );
};

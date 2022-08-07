import winston, { format, createLogger } from 'winston';
import { inspect } from 'util';

export const logger = createLogger({
    level: 'silly',
    format: format.simple(),
    // format: format.combine(
    //     format(({ level, message, meta }) => ({
    //         level,
    //         meta,
    //         message:
    //             level +
    //             ' - ' +
    //             message +
    //             (_.isEmpty(meta) ? '' : ' - ' + inspect(meta)),
    //     }))(),
    // ),

    transports: [new winston.transports.Console()],
});

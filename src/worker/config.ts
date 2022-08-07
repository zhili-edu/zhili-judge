import { logger } from '../lib/winston-common';
import commandLineArgs from 'command-line-args';
import { readFileSync } from 'fs';
import type { JsonObject } from 'type-fest';
import globalCfg from '../config.json';
import { readJSON } from '../utils';

const optionDefinitions = [
    { name: 'verbose', alias: 'v', type: Boolean },
    { name: 'config', alias: 'c', type: String },
];
const options = commandLineArgs(optionDefinitions);

const userConfig = readJSON(options['config']);
const globalConfig = Object.assign(globalCfg, userConfig);

export default globalConfig;

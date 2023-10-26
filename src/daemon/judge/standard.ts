import type { Test, TestCase } from '../interface/test.js';
import {
    TaskStatus,
    type CompilationResult,
    type StandardRunTask,
    type StandardRunResult,
    RPCTaskType,
    TestcaseResultType,
} from '../../interfaces.js';
import globalConfig from '../config.js';
import { compile } from './compile.js';
import { languages, getLanguage } from '../../languages/index.js';
import { runTask } from '../../lib/rmq-common.js';
import { JudgerBase } from './judger-base.js';
import { mongo, amqp } from '../index.js';
import { logger } from '../../lib/winston-common.js';
import {
    type CaseState,
    CaseStatus,
    type JudgeTask,
} from '../interface/judgeTask.js';

export class StandardJudger extends JudgerBase {
    spjExecutableName: string = null;
    userCodeExecuableName: string = null;
    lang: string;
    code: string;

    constructor(
        testData: Test,
        task: JudgeTask,
        priority: number,
        lang: string,
        code: string,
    ) {
        super(testData, task, priority);

        this.lang = lang;
        this.code = code;
    }

    // compiling spj
    async preprocessTestData(): Promise<void> {
        if (this.testData.spj) {
            logger.verbose('Compiling special judge.');
            const lang = languages.find(
                (l) => l.name === this.testData.spj.lang,
            );
            if (!lang) throw new Error('Unknown SPJ Language');
            const [spjExecutableName, spjResult] = await compile(
                this.testData.spj.code,
                lang,
                null,
                this.priority,
            );
            if (spjResult.status !== TaskStatus.Done) {
                logger.verbose('Special judge CE: ' + spjResult.message);
                let message = null;
                if (spjResult.message != null && spjResult.message !== '') {
                    message =
                        '===== Special Judge Compilation Message =====' +
                        spjResult.message;
                }
                throw new Error(message);
            } else {
                this.spjExecutableName = spjExecutableName;
            }
        } else {
            this.spjExecutableName = null;
        }
    }

    async compile(): Promise<CompilationResult> {
        const language = getLanguage(this.lang);
        const [executableName, compilationResult] = await compile(
            this.code,
            language,
            [], // TODO: this.testData.extraSourceFiles[language.name],
            this.priority,
        );
        this.userCodeExecuableName = executableName;

        return compilationResult;
    }

    async judgeTestcase(
        curCase: TestCase,
        started: () => void,
    ): Promise<CaseState> {
        logger.debug(
            `judge case: input ${curCase.input}, output ${curCase.output}, prefix ${curCase.prefix}`,
        );
        const task: StandardRunTask = {
            testDataName: curCase.prefix,
            inputData: curCase.input, // fileId
            answerData: curCase.output, // fileId
            time: this.testData.limit.timeLimit,
            memory: this.testData.limit.memoryLimit,
            // TODO:
            // fileIOInput: this.parameters.fileIOInput,
            // fileIOOutput: this.parameters.fileIOOutput,
            userExecutableName: this.userCodeExecuableName,
            spjExecutableName: this.spjExecutableName,
        };

        const runResult: StandardRunResult = await runTask(
            amqp,
            { type: RPCTaskType.RunStandard, task: task },
            this.priority,
            started,
        );

        let inputContent: string;
        let outputContent: string;
        if (
            runResult.result === TestcaseResultType.FileError ||
            runResult.result === TestcaseResultType.JudgementFailed ||
            runResult.result === TestcaseResultType.InvalidInteraction
        ) {
            inputContent = '';
            outputContent = '';
        } else {
            [inputContent, outputContent] = await Promise.all([
                mongo.readFileIdByLength(
                    curCase.input,
                    globalConfig.worker.dataDisplayLimit,
                ),
                mongo.readFileIdByLength(
                    curCase.output,
                    globalConfig.worker.dataDisplayLimit,
                ),
            ]);
        }

        return {
            prefix: curCase.prefix,
            caseStatus: CaseStatus[TestcaseResultType[runResult.result]],
            detail: {
                time: runResult.time,
                memory: runResult.memory,
                input: inputContent,
                output: outputContent,
                // scoringRate: runResult.scoringRate,
                userOutput: runResult.userOutput,
                userError: runResult.userError,
                spjMessage: runResult.spjMessage,
                systemMessage: runResult.systemMessage,
            },
        };
    }
}

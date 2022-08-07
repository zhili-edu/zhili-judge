import { logger } from '../../lib/winston-common';
import { Test } from '../interface/test.js';
import { ProblemType } from '../interface/test.js';
import {
    CaseStatus,
    JudgeState,
    JudgeStateStatus,
    JudgeTask,
    setStatus,
} from '../interface/judgeTask.js';
import { StandardJudger } from './standard.js';
import { JudgerBase } from './judger-base.js';
import {
    JudgeResult,
    ErrorType,
    OverallResult,
    CompilationResult,
    TaskStatus,
} from '../../interfaces.js';
// TODO: add support for :
// import { AnswerSubmissionJudger } from './submit-answer';
// import { InteractionJudger } from './interaction';

import { mongo } from '../index.js';

export const judge = async (
    task: JudgeTask,
    // extraData: Buffer,
    reportProgress: (p: JudgeTask) => void,
): Promise<void> => {
    logger.verbose(`Begin to process judge task ${task.taskId}`);

    logger.debug('Fetching testdata');
    let testData: Test = null;
    try {
        testData = await mongo.getTest(task.pid);
    } catch (err) {
        logger.info(`Fetching testdata err for ${task.taskId}: ${err}`);
        setStatus(task.judgeState, JudgeStateStatus.NoTestdata);
        task.judgeState.errorMessage = err.toString();
        return;
    }

    let judger: JudgerBase = new StandardJudger(
        testData,
        task,
        task.priority,
        task.lang,
        task.code,
    );

    /*if (task.type === ProblemType.Standard) {
        judger = new StandardJudger(testData, task.param as StandardJudgeParameter, task.priority);
    } else if (task.type === ProblemType.AnswerSubmission) {
        judger = new AnswerSubmissionJudger(testData, extraData, task.priority);
    } else if (task.type === ProblemType.Interaction) {
        judger = new InteractionJudger(testData, task.param as InteractionJudgeParameter, task.priority);
    } else {
        throw new Error(`Task type not supported`);
    }*/

    logger.debug('Preprocessing testdata...');
    try {
        await judger.preprocessTestData();
    } catch (err) {
        logger.verbose(`Preprocess testdata err for ${task.taskId}: ${err}`);
        setStatus(task.judgeState, JudgeStateStatus.NoTestdata);
        task.judgeState.errorMessage = err.toString();
        return;
    }

    logger.debug(`Compiling...`);
    task.judgeState.status = JudgeStateStatus.Compiling;
    // setStatus(task.judgeState, JudgeStateStatus.Compiling);
    reportProgress(task);
    const compileResult = await judger.compile();
    logger.debug(`Reporting compilation progress...`);
    if (compileResult.status !== TaskStatus.Done) {
        logger.verbose(
            `Compilation err for ${task.taskId}: ${compileResult.message}`,
        );
        task.judgeState.status = JudgeStateStatus.CompileError;
        task.judgeState.subtasks.map((sub) =>
            sub.testcases.map((c) => (c.caseStatus = CaseStatus.Skipped)),
        );
        // setStatus(task.judgeState, JudgeStateStatus.CompileError);
        task.judgeState.errorMessage = compileResult.message;
        return;
    }

    logger.debug('Judging...');
    task.judgeState.status = JudgeStateStatus.Judging;
    // setStatus(task.judgeState, JudgeStateStatus.Judging);
    reportProgress(task);
    await judger.judge(reportProgress);

    await judger.cleanup();
};

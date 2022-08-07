import {
    Test,
    SubtaskScoringType,
    TestCase,
    Subtask,
} from '../interface/test.js';
import {
    CompilationResult,
    JudgeResult,
    TaskStatus,
    SubtaskResult,
    TestcaseDetails,
} from '../../interfaces.js';
import { logger } from '../../lib/winston-common';
import {
    CaseDetail,
    CaseState,
    CaseStatus,
    JudgeState,
    JudgeTask,
    SubtaskState,
} from '../interface/judgeTask.js';
import { inspect } from 'util';

function calculateSubtaskScore(
    scoringType: 'sum' | 'mul' | 'min',
    scores: number[],
): number {
    switch (scoringType) {
        case 'sum':
            return (
                scores.reduce((prev, curr) => prev + curr, 0) / scores.length
            );
        case 'min':
            return Math.min(...scores);
        case 'mul':
            return scores.reduce((prev, curr) => prev * curr, 1);
    }
}

export abstract class JudgerBase {
    priority: number;
    testData: Test;
    task: JudgeTask;

    constructor(test: Test, task: JudgeTask, p: number) {
        logger.verbose('Contructing JudgerBase');
        this.testData = test;
        this.task = task;
        this.priority = p;

        logger.silly(inspect(this.testData, { depth: 100 }));
    }

    async preprocessTestData(): Promise<void> {}

    abstract compile(): Promise<CompilationResult>;

    // judge a subtask consecutively, skip when having a 0 score.
    // TODO: mul type sbutask
    async skipJudge(
        subIdx: number,
        report: (t: JudgeTask) => void,
    ): Promise<void> {
        if (!this.testData.subtasks[subIdx])
            throw new Error(`Judging subtask ${subIdx}: data not exist`);

        if (!this.task.judgeState.subtasks[subIdx])
            throw new Error(`Judging subtask ${subIdx}: state not exist`);

        logger.verbose(`Judging subtask ${subIdx} in skippable`);

        // set an initial score for min
        this.task.judgeState.subtasks[subIdx].score =
            this.testData.subtasks[subIdx].score;
        let skipped = false;

        for (const [caseIdx, c] of this.testData.subtasks[
            subIdx
        ].cases.entries()) {
            if (skipped) {
                logger.verbose(`Skipping subtask ${subIdx}, case ${caseIdx}.`);
                this.task.judgeState.subtasks[subIdx].testcases[
                    caseIdx
                ].caseStatus = CaseStatus.Skipped;
                continue;
            }

            logger.verbose(`Judging subtask ${subIdx}, case ${caseIdx}.`);
            const caseState = await this.judgeTestcase(c, () => {
                this.task.judgeState.subtasks[subIdx].testcases[
                    caseIdx
                ].caseStatus = CaseStatus.Judging;
                report(this.task);
            });
            this.task.judgeState.subtasks[subIdx].testcases[caseIdx] =
                caseState;

            // Skip the rest
            if (caseState.caseStatus !== CaseStatus.Accepted) {
                skipped = true;
                this.task.judgeState.subtasks[subIdx].score = 0;
            }

            report(this.task);
        }

        this.task.score += this.task.judgeState.subtasks[subIdx].score;
        report(this.task);
    }

    // judge a subtask in parallel
    async parallelJudge(
        subIdx: number,
        report: (t: JudgeTask) => void,
    ): Promise<void> {
        if (!this.testData.subtasks[subIdx])
            throw new Error(`Judging subtask ${subIdx}: data not exist`);

        if (!this.task.judgeState.subtasks[subIdx])
            throw new Error(`Judging subtask ${subIdx}: state not exist`);

        logger.verbose(`Judging subtask ${subIdx} in parallel`);

        this.task.judgeState.subtasks[subIdx].score = 0;
        logger.silly(
            `Subtask ${subIdx} score: ${this.task.judgeState.subtasks[subIdx].score}`,
        );
        await Promise.all(
            this.testData.subtasks[subIdx].cases.map(async (c, caseIdx) => {
                logger.verbose(`Judging subtask ${subIdx}, case ${caseIdx}.`);

                const caseState = await this.judgeTestcase(c, () => {
                    this.task.judgeState.subtasks[subIdx].testcases[
                        caseIdx
                    ].caseStatus = CaseStatus.Judging;
                    report(this.task);
                });
                this.task.judgeState.subtasks[subIdx].testcases[caseIdx] =
                    caseState;

                this.task.judgeState.subtasks[subIdx].score = Math.floor(
                    this.task.judgeState.subtasks[subIdx].testcases.reduce(
                        (cnt, c) =>
                            cnt +
                            (c.caseStatus === CaseStatus.Accepted
                                ? this.testData.subtasks[subIdx].score
                                : 0),
                        0,
                    ) / this.testData.subtasks[subIdx].cases.length,
                );

                logger.silly(
                    `Subtask ${subIdx} score: ${this.task.judgeState.subtasks[subIdx].score}`,
                );
                report(this.task);
            }),
        );

        this.task.score += this.task.judgeState.subtasks[subIdx].score;
        logger.silly(`Task Score: ${this.task.score}`);
        report(this.task);
    }

    // all subtasks are judged in parallel
    // test cases are judged depending on its scoring scheme
    async judge(report: (t: JudgeTask) => void): Promise<void> {
        await Promise.all(
            this.testData.subtasks.map((sub, idx) =>
                sub.type === 'sum'
                    ? this.parallelJudge(idx, report)
                    : this.skipJudge(idx, report),
            ),
        );
    }

    protected abstract judgeTestcase(
        curCase: TestCase,
        started: () => void,
    ): Promise<CaseState>;

    async cleanup() {}
}

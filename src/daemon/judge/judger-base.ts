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
        this.testData = test;
        this.task = task;
        this.priority = p;
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

        this.task.judgeState.subtasks[subIdx].score = 0;
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
                    this.task.judgeState.subtasks[subIdx].score +
                        caseState.caseStatus ===
                        CaseStatus.Accepted
                        ? this.testData.subtasks[subIdx].score
                        : 0,
                );

                report(this.task);
            }),
        );

        this.task.score += this.task.judgeState.subtasks[subIdx].score;
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
        // const updateSubtaskScore = (subtaskIndex: number) => {
        //     const subtask = task.judgeState.subtasks[subtaskIndex];
        //     if (!subtask || !this.testData.subtasks[subtaskIndex]) return;
        //     subtask.score = calculateSubtaskScore(
        //         this.testData.subtasks[subtaskIndex].type,
        //         subtask.testcases.map(
        //             (c) =>
        //                 (c.caseStatus === CaseStatus.Accepted ? 1 : 0) *
        //                 this.testData.subtasks[subtaskIndex].score,
        //         ),
        //     );
        // };
        // const testcaseDetailsCache: Map<string, CaseState> = new Map();
        // const judgeTestcaseWrapper = async (
        //     curCase: TestCase,
        //     started: () => Promise<void>,
        // ): Promise<CaseState> => {
        //     if (testcaseDetailsCache.has(curCase.prefix)) {
        //         return testcaseDetailsCache.get(curCase.prefix);
        //     }
        //     const result: CaseState = await this.judgeTestcase(
        //         curCase,
        //         started,
        //     );
        //     testcaseDetailsCache.set(curCase.prefix, result);
        //     return result;
        // };
        // for (
        //     let subtaskIndex = 0;
        //     subtaskIndex < this.testData.subtasks.length;
        //     subtaskIndex++
        // ) {
        //     updateSubtaskScore(subtaskIndex);
        // }
        // logger.debug(`Totally ${task.judgeState.subtasks.length} subtasks.`);
        // const judgeTasks: Promise<void>[] = [];
        // for (
        //     let subtaskIndex = 0;
        //     subtaskIndex < this.testData.subtasks.length;
        //     subtaskIndex++
        // ) {
        //     const currentResult = task.judgeState.subtasks[subtaskIndex];
        //     const currentTask = this.testData.subtasks[subtaskIndex];
        //     const updateCurrentSubtaskScore = () =>
        //         updateSubtaskScore(subtaskIndex);
        //     judgeTasks.push(
        //         (async () => {
        //             // Type minimum and multiply is skippable, run one by one
        //             if (currentTask.type !== 'sum') {
        //                 let skipped: boolean = false;
        //                 for (
        //                     let index = 0;
        //                     index < currentTask.cases.length;
        //                     index++
        //                 ) {
        //                     const currentCaseResult =
        //                         currentResult.testcases[index];
        //                     if (skipped) {
        //                         currentCaseResult.caseStatus =
        //                             CaseStatus.Skipped;
        //                     } else {
        //                         logger.verbose(
        //                             `Judging ${subtaskIndex}, case ${index}.`,
        //                         );
        //                         let score = 0;
        //                         try {
        //                             const caseState =
        //                                 await judgeTestcaseWrapper(
        //                                     currentTask.cases[index],
        //                                     async () => {
        //                                         currentCaseResult.caseStatus =
        //                                             CaseStatus.Judging;
        //                                         reportProgress(task);
        //                                     },
        //                                 );
        //                             currentResult.testcases[index] = caseState;
        //                         } catch (err) {
        //                             currentCaseResult.caseStatus =
        //                                 CaseStatus.SystemError;
        //                             currentCaseResult.errorMessage =
        //                                 err.toString();
        //                             logger.warn(
        //                                 `Task runner error: ${err.toString()} (subtask ${subtaskIndex}, case ${index})`,
        //                             );
        //                         }
        //                         if (
        //                             score == null ||
        //                             isNaN(score) ||
        //                             score === 0
        //                         ) {
        //                             logger.debug(
        //                                 `Subtask ${subtaskIndex}, case ${index}: zero, skipping the rest.`,
        //                             );
        //                             skipped = true;
        //                         }
        //                         updateCurrentSubtaskScore();
        //                         reportProgress(task);
        //                     }
        //                 }
        //             } else {
        //                 // Non skippable, run all immediately
        //                 const caseTasks: Promise<void>[] = [];
        //                 for (
        //                     let index = 0;
        //                     index < currentTask.cases.length;
        //                     index++
        //                 ) {
        //                     caseTasks.push(
        //                         (async () => {
        //                             const currentCaseResult =
        //                                 currentResult.testcases[index];
        //                             logger.verbose(
        //                                 `Judging ${subtaskIndex}, case ${index}.`,
        //                             );
        //                             try {
        //                                 const caseState =
        //                                     await judgeTestcaseWrapper(
        //                                         currentTask.cases[index],
        //                                         async () => {
        //                                             currentCaseResult.caseStatus =
        //                                                 CaseStatus.Judging;
        //                                             reportProgress(task);
        //                                         },
        //                                     );
        //                                 currentResult.testcases[index] =
        //                                     caseState;
        //                             } catch (err) {
        //                                 currentCaseResult.caseStatus =
        //                                     CaseStatus.SystemError;
        //                                 currentCaseResult.errorMessage =
        //                                     err.toString();
        //                                 logger.warn(
        //                                     `Task runner error: ${err.toString()} (subtask ${subtaskIndex}, case ${index})`,
        //                                 );
        //                             }
        //                             updateCurrentSubtaskScore();
        //                             reportProgress(task);
        //                         })(),
        //                     );
        //                 }
        //                 await Promise.all(caseTasks);
        //             }
        //             updateCurrentSubtaskScore();
        //             logger.verbose(`Subtask ${subtaskIndex}, finished`);
        //         })(),
        //     );
        // }
        // await Promise.all(judgeTasks);
        // return task;
    }

    protected abstract judgeTestcase(
        curCase: TestCase,
        started: () => void,
    ): Promise<CaseState>;

    async cleanup() {}
}

import { logger } from '../../lib/winston-common';
type taskId = string;

export enum JudgeStateStatus {
    // case status
    Accepted = 'Accepted',
    WrongAnswer = 'Wrong Answer',
    PartiallyCorrect = 'Partially Correct',
    MemoryLimitExceeded = 'Memory Limit Exceeded',
    TimeLimitExceeded = 'Time Limit Exceeded',
    OutputLimitExceeded = 'Output Limit Exceeded',
    FileError = 'File Error',
    RuntimeError = 'Runtime Error',
    JudgementFailed = 'Judgement Failed',
    InvalidInteraction = 'Invalid Interaction',
    SystemError = 'System Error',

    // judge status
    CompileError = 'Compile Error',
    NoTestdata = 'No Testdata',
    Unknown = 'Unknown',

    // processing status
    // the judge task in in the queue
    Waiting = 'Waiting',
    // the judge has begun but not finished
    // Pending = 'Pending',
    Compiling = 'Compiling',
    Judging = 'Judging',
}

export enum CaseStatus {
    Accepted = 'Accepted',
    WrongAnswer = 'Wrong Answer',
    PartiallyCorrect = 'Partially Correct',
    MemoryLimitExceeded = 'Memory Limit Exceeded',
    TimeLimitExceeded = 'Time Limit Exceeded',
    OutputLimitExceeded = 'Output Limit Exceeded',
    FileError = 'File Error',
    RuntimeError = 'Runtime Error',
    JudgementFailed = 'Judgement Failed',
    InvalidInteraction = 'Invalid Interaction',
    SystemError = 'System Error',

    Skipped = 'Skipped',

    Waiting = 'Waiting',
    Judging = 'Judging',
    // Pending = 'Pending',
}

export type JudgeTask = {
    priority: number;
    taskId: taskId;
    pid: string;
    code: string;
    lang: string;
    score: number;
    // extraData?: Buffer;
    judgeState: JudgeState;
};

export type JudgeState = {
    status: JudgeStateStatus;
    errorMessage?: string;
    subtasks: SubtaskState[];
};

export type SubtaskState = {
    score: number;
    testcases: CaseState[];
};

export type CaseState = {
    prefix: string;
    caseStatus: CaseStatus;
    errorMessage?: string;
    detail?: CaseDetail;
};

export type CaseDetail = {
    time: number;
    memory: number;
    input?: string;
    output?: string;
    // scoringRate: number; // e.g. 0.5
    userOutput?: string;
    userError?: string;
    spjMessage?: string;
    systemMessage?: string;
};

// helper functions for JudgeState

export function setStatus(j: JudgeState, s: JudgeStateStatus) {
    logger.verbose('Setting judgeState status...');
    logger.silly(s);

    switch (s) {
        case JudgeStateStatus.CompileError:
        case JudgeStateStatus.NoTestdata:
        case JudgeStateStatus.SystemError:
        case JudgeStateStatus.Unknown:
            j.subtasks.map((sub) =>
                sub.testcases.map((c) => (c.caseStatus = CaseStatus.Skipped)),
            );
        // fall through
        default:
            j.status = s;
    }
}

export const getStatus = (j: JudgeState) => {
    // Only set Judging to other states.
    if (j.status !== JudgeStateStatus.Judging) return;

    const cases = j.subtasks.map((sub) => sub.testcases).flat();

    // all Waiting => Waiting
    if (cases.every((c) => c.caseStatus === CaseStatus.Waiting))
        j.status = JudgeStateStatus.Waiting;
    // some Waitng / Judging => Judging
    else if (
        cases.some(
            (c) =>
                c.caseStatus === CaseStatus.Waiting ||
                c.caseStatus === CaseStatus.Judging,
        )
    )
        j.status = JudgeStateStatus.Judging;
    // all Accepted => Accepted
    else if (cases.every((c) => c.caseStatus === CaseStatus.Accepted))
        j.status = JudgeStateStatus.Accepted;
    // all Skipped => SystemError
    else if (cases.every((c) => c.caseStatus === CaseStatus.Skipped))
        j.status = JudgeStateStatus.SystemError;
    // first case status
    else
        j.status =
            (cases.find(
                (c) =>
                    ![
                        CaseStatus.Accepted,
                        CaseStatus.Skipped,
                        CaseStatus.Judging,
                        CaseStatus.Waiting,
                    ].includes(c.caseStatus),
            )?.caseStatus as unknown as JudgeStateStatus) ??
            JudgeStateStatus.SystemError;
};

import type { Language } from './languages';

export interface StandardRunTask {
    inputData: string;
    answerData: string;

    time: number;
    memory: number;

    lang: Language;
    userExecutableName: string;
}

export interface TestcaseDetails {
    type: TestcaseResultType;
    time: number;
    memory: number;
    input?: FileContent;
    output?: FileContent; // Output in test data
    scoringRate: number; // e.g. 0.5
    userOutput?: string;
    userError?: string;
    spjMessage?: string;
    systemMessage?: string;
}

export interface TestcaseResult {
    status: TaskStatus;
    result?: TestcaseDetails;
    errorMessage?: string;
}

export enum ErrorType {
    SystemError,
    TestDataError,
}

export type StandardRunResult = {
    time: number;
    memory: number;
    userOutput: string;
    userError: string;

    systemMessage: string | null;
    result: TestcaseResultType;
};

export enum TaskStatus {
    Waiting = 0,
    Running = 1,
    Done = 2,
    Failed = 3,
    Skipped = 4,
}

export enum TestcaseResultType {
    Accepted = 1,
    WrongAnswer = 2,
    PartiallyCorrect = 3,
    MemoryLimitExceeded = 4,
    TimeLimitExceeded = 5,
    OutputLimitExceeded = 6,
    FileError = 7, // The output file does not exist
    RuntimeError = 8,
    JudgementFailed = 9, // Special Judge or Interactor fails
    InvalidInteraction = 10,
}

export interface FileContent {
    content: string;
    name: string;
}

export type JudgeStatus =
    | 'in_queue'
    | 'compiling'
    | 'judging'
    | 'accepted'
    | 'wrong_answer'
    | 'runtime_error'
    | 'compile_error'
    | 'time_limit_exceeded'
    | 'memory_limit_exceeded'
    | 'judgement_failed';

export type CaseStatus =
    | 'waiting'
    | 'judging'
    | 'accepted'
    | 'wrong_answer'
    | 'runtime_error'
    | 'time_limit_exceeded'
    | 'memory_limit_exceeded'
    | 'judgement_failed';

export interface CaseEmit {
    num: number;

    time_usage: number;
    memory_usage: number;
    case_status: CaseStatus | null;

    user_in: string | null;
    user_out: string | null;
    user_error: string | null;
    answer_out: string | null;
    spj_message: string | null;
    system_message: string | null;
}

export interface SubtaskEmit {
    cases: CaseEmit[];

    score: number;
    kind: 'sum' | 'min';
}

export interface SubmissionUpdate {
    score: number;
    judge_status: JudgeStatus;
    time_usage: number;
    memory_usage: number;
    error_message: string | null;

    subtasks: SubtaskEmit[];
}

import type { TaskStatus } from '../../interfaces.js';

export enum ProblemType {
    Standard = 1,
    AnswerSubmission = 2,
    Interaction = 3,
}

export enum SubtaskScoringType {
    Summation = 'sum',
    Minimum = 'min',
    Multiple = 'mul',
}

export interface Problem {
    limit: Limit;
    test?: Test;
    // type: ProblemType
}

export interface Limit {
    timeLimit: number; // in ms
    memoryLimit: number; // in byte
}

export interface Test {
    subtasks: Subtask[];
    limit: Limit;
    spj?: Executable;
    interactor?: Executable;
}

export interface Executable {
    lang: string;
    code: string;
}

export interface Subtask {
    score: number;
    type: 'sum' | 'mul' | 'min';
    cases: TestCase[];
}

export interface TestCase {
    prefix: string;
    input: string;
    output: string;
}

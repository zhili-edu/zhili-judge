import { lang } from "./cpp.js";

export const languages: Language[] = [lang];

export interface ExecParam {
  executable: string;
  parameters: string[];
  time: number;
  memory: number;
  process: number;
  stdin?: string | number;
  stdout?: string | number;
  stderr?: string | number;
  messageFile: string;
  workingDirectory: string;
}

export interface Language {
  name: string;
  fileExtension: string;

  sourceFileName: string;
  binarySizeLimit: number;
  compile: (
    sourcePath: string,
    outputDirectory: string,
    doNotUseX32Abi: boolean,
  ) => ExecParam;
  run: (
    binaryDirectory: string,
    workingDirectory: string,
    time: number,
    memory: number,
    stdinFile?: string | number,
    stdoutFile?: string | number,
    stderrFile?: string | number,
  ) => ExecParam;
}

export const getLanguage = (name: string): Language | undefined =>
  languages.find((l) => l.name === name);

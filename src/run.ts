import { mkdir, opendir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  type SandboxParameter,
  type SandboxResult,
  SandboxStatus,
  getUidAndGidInSandbox,
  startSandbox,
} from "simple-sandbox";
import config from "./config.json";
import type { Language } from "./languages/index.js";
import mainLogger from "./lib/logger.js";
import { getFolderSize as getSize, setWriteAccess } from "./utils.js";

export interface RunResult {
  outputLimitExceeded: boolean;
  result: SandboxResult;
}

export interface DiffResult {
  pass: boolean;
  message: string;
}

export async function runDiff(
  num: number,
  dataDir: string,
  file1: string,
  file2: string,
): Promise<DiffResult> {
  await setWriteAccess(dataDir, true);
  const tmpPath = `/sandbox${num}/1`;
  const outputFileName = "diff.txt";
  const sandbox = startSandbox({
    ...config.sandbox,
    cgroup: `${config.sandbox.cgroup}${num}`,
    user: getUidAndGidInSandbox(config.sandbox.chroot, config.sandbox.user),
    executable: "/usr/bin/diff",
    parameters: ["/usr/bin/diff", "-Bbq", file1, file2],
    time: config.worker.spjTimeLimit,
    memory: config.worker.spjMemoryLimit * 1024 * 1024,
    process: 2,
    stdin: undefined,
    stdout: outputFileName,
    stderr: undefined,
    workingDirectory: tmpPath,
    mounts: [
      {
        src: dataDir,
        dst: tmpPath,
        limit: -1,
      },
    ],
  });
  const sandboxResult = await sandbox.waitForStop();

  if (sandboxResult.status !== SandboxStatus.OK) {
    return {
      pass: false,
      message: `Diff encountered ${SandboxStatus[sandboxResult.status]}`,
    };
  }

  const message = await readFile(path.join(dataDir, outputFileName), "utf8");
  return { pass: sandboxResult.code === 0, message: message };
}

export async function runProgram(
  num: number,
  language: Language,
  binDir: string,
  dataDir: string,
  time: number,
  memory: number,
  stdinFile?: string | number,
  stdoutFile?: string | number,
  stderrFile?: string | number,
): Promise<[Promise<RunResult>, () => void]> {
  const logger = mainLogger.child({ num });

  await setWriteAccess(binDir, false);
  await setWriteAccess(dataDir, true);

  const dataDir_Sandbox = `/sandbox${num}/1`;
  const binDir_Sandbox = `/sandbox${num}/2`;
  const runConfig = language.run(
    binDir_Sandbox,
    dataDir_Sandbox,
    time,
    memory,
    stdinFile,
    stdoutFile,
    stderrFile,
  );

  const sandboxParam: SandboxParameter = {
    ...config.sandbox,
    ...runConfig,
    cgroup: `${config.sandbox.cgroup}${num}`,
    user: getUidAndGidInSandbox(config.sandbox.chroot, config.sandbox.user),
    mounts: [
      {
        src: binDir,
        dst: binDir_Sandbox,
        limit: 0,
      },
      {
        src: dataDir,
        dst: dataDir_Sandbox,
        limit: -1,
      },
    ],
  };

  logger.trace(sandboxParam);

  const dir = await opendir(dataDir);
  for await (const d of dir) {
    logger.trace(d.name);
  }
  const dir2 = await opendir(binDir);
  for await (const d of dir2) {
    logger.trace(d.name);
  }

  const sandbox = startSandbox(sandboxParam);
  return [
    (async () => {
      const result = await sandbox.waitForStop();

      let outputLimitExceeded = false;
      const outputSize = await getSize(dataDir);
      if (outputSize > config.worker.outputLimit) {
        await rm(dataDir, { recursive: true }).then(() => mkdir(dataDir));
        outputLimitExceeded = true;
        if (result.status === SandboxStatus.OK)
          result.status = SandboxStatus.OutputLimitExceeded;
      }

      return { outputLimitExceeded, result };
    })(),
    () => {
      sandbox.stop();
    },
  ];
}

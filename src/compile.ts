import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type SandboxParameter,
  SandboxStatus,
  getUidAndGidInSandbox,
  startSandbox,
} from "simple-sandbox";
import config from "./config.json";
import { TaskStatus } from "./interfaces.js";
import type { Language } from "./languages/index.js";
import {
  createEmptyDir,
  getFolderSize as getSize,
  readFileLength,
  setWriteAccess,
} from "./utils.js";

export interface CompileTask {
  code: string;
  lang: Language;
  binaryName: string;
}

export interface CompilationResult {
  status: TaskStatus;
  message: string;
}

export async function compile({
  code,
  lang,
  binaryName,
}: CompileTask): Promise<CompilationResult> {
  const srcDir = `${config.tmpDir}/src`;
  const binDir = `${config.tmpDir}/bin/${binaryName}`;
  const tempDir = `${config.tmpDir}/temp`;

  await Promise.all([
    createEmptyDir(srcDir),
    createEmptyDir(binDir),
    createEmptyDir(tempDir),
  ]);
  await Promise.all([
    setWriteAccess(srcDir, false),
    setWriteAccess(binDir, true),
    setWriteAccess(tempDir, true),
  ]);

  await writeFile(`${srcDir}/${lang.sourceFileName}`, code, {
    encoding: "utf8",
  });

  const srcDir_Sandbox = "/sandbox0/1";
  const binDir_Sandbox = "/sandbox0/2";
  const compileConfig = lang.compile(
    `${srcDir_Sandbox}/${lang.sourceFileName}`,
    binDir_Sandbox,
    config.worker.doNotUseX32ABI,
  );

  const sandboxParam: SandboxParameter = {
    ...config.sandbox,
    ...compileConfig,
    user: getUidAndGidInSandbox(config.sandbox.chroot, config.sandbox.user),
    mounts: [
      {
        src: srcDir,
        dst: srcDir_Sandbox,
        limit: 0,
      },
      {
        src: binDir,
        dst: binDir_Sandbox,
        limit: -1,
      },
      {
        src: tempDir,
        dst: "/tmp",
        limit: -1,
      },
    ],
  };

  const sandbox = startSandbox(sandboxParam);
  const sandboxResult = await sandbox.waitForStop();

  // If the compiler exited
  if (sandboxResult.status === SandboxStatus.OK) {
    // If the compiler did not return an error
    if (sandboxResult.code === 0) {
      const outputSize = await getSize(binDir);
      // If the output is too long
      if (outputSize > lang.binarySizeLimit) {
        return {
          status: TaskStatus.Failed,
          message: `Your source code compiled to ${outputSize} bytes which is too big...`,
        };
      } // Else OK!
    } else {
      // If compilation error
      return {
        status: TaskStatus.Failed,
        message: await readFileLength(
          path.join(binDir, compileConfig.messageFile),
          config.worker.compilerMessageLimit,
        ),
      };
    }
  } else {
    return {
      status: TaskStatus.Failed,
      message: `A ${
        SandboxStatus[sandboxResult.status]
      } encountered while compiling your code.\n\n${await readFileLength(
        `${binDir}/${compileConfig.messageFile}`,
        config.worker.compilerMessageLimit,
      )}`.trim(),
    };
  }

  return {
    status: TaskStatus.Done,
    message: await readFileLength(
      path.join(binDir, compileConfig.messageFile),
      config.worker.compilerMessageLimit,
    ),
  };
}

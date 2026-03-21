import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class FileArtifactStore {
  constructor(private readonly rootDir: string) {
    mkdirSync(this.rootDir, { recursive: true });
  }

  getTaskDir(taskId: string): string {
    const taskDir = join(this.rootDir, taskId);
    mkdirSync(taskDir, { recursive: true });
    return taskDir;
  }

  writeJson(taskId: string, name: string, value: unknown): string {
    const filePath = join(this.getTaskDir(taskId), name);
    writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
    return filePath;
  }

  writeText(taskId: string, name: string, value: string): string {
    const filePath = join(this.getTaskDir(taskId), name);
    writeFileSync(filePath, value, "utf8");
    return filePath;
  }

  recordCommandOutput(taskId: string, prefix: string, stdout: string, stderr: string): {
    stdoutPath: string;
    stderrPath: string;
    combinedPath: string;
  } {
    const safePrefix = prefix.replace(/[^a-z0-9_-]+/gi, "-");
    const stdoutPath = this.writeText(taskId, `${safePrefix}.stdout.log`, stdout);
    const stderrPath = this.writeText(taskId, `${safePrefix}.stderr.log`, stderr);
    const combinedPath = this.writeText(
      taskId,
      `${safePrefix}.combined.log`,
      `STDOUT\n${stdout}\n\nSTDERR\n${stderr}`
    );

    return {
      stdoutPath,
      stderrPath,
      combinedPath
    };
  }
}

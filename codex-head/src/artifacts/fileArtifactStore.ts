import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class FileArtifactStore {
  constructor(private readonly rootDir: string) {
    mkdirSync(this.rootDir, { recursive: true });
  }

  getOperatorActionsDir(): string {
    const dir = join(this.rootDir, "operator-actions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  getTaskDir(taskId: string): string {
    const taskDir = join(this.rootDir, taskId);
    mkdirSync(taskDir, { recursive: true });
    return taskDir;
  }

  resolveTaskDir(taskId: string): string {
    return join(this.rootDir, taskId);
  }

  resolveTaskArtifactPath(taskId: string, name: string): string {
    return join(this.rootDir, taskId, name);
  }

  writeJson(taskId: string, name: string, value: unknown): string {
    const filePath = join(this.getTaskDir(taskId), name);
    writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
    return filePath;
  }

  writeOperatorReceipt(commandName: string, value: unknown): string {
    const timestamp = new Date().toISOString().replace(/:/g, "-");
    const safeCommand = commandName.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
    const fileName = `${timestamp}-${safeCommand}.json`;
    const filePath = join(this.getOperatorActionsDir(), fileName);
    writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
    return `operator-actions/${fileName}`;
  }

  listOperatorReceipts(): string[] {
    return readdirSync(this.getOperatorActionsDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => `operator-actions/${entry.name}`)
      .sort()
      .reverse();
  }

  readOperatorReceiptIfExists<T>(receiptPath: string): T | null {
    const normalized = receiptPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized.startsWith("operator-actions/")) {
      return null;
    }

    const filePath = join(this.rootDir, normalized);
    if (!existsSync(filePath)) {
      return null;
    }

    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  }

  readJsonIfExists<T>(taskId: string, name: string): T | null {
    const filePath = this.resolveTaskArtifactPath(taskId, name);
    if (!existsSync(filePath)) {
      return null;
    }
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
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

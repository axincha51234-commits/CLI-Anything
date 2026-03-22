import { spawnSync } from "node:child_process";

import type { CommandTemplate } from "../config";

export interface CommandRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export function findInstalledBinary(bin: string): string | null {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, [bin], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  const firstLine = String(result.stdout || "").trim().split(/\r?\n/)[0];
  return firstLine || null;
}

export function interpolateTemplate(
  template: CommandTemplate,
  values: Record<string, string | null>
): { executable: string; args: string[]; env: Record<string, string> } {
  const interpolate = (value: string): string =>
    value.replace(/\{\{([^}]+)\}\}/g, (_match, key) => values[key.trim()] ?? "");

  return {
    executable: interpolate(template.executable),
    args: template.args.map((arg) => interpolate(arg)),
    env: Object.fromEntries(
      Object.entries(template.env ?? {}).map(([key, value]) => [key, interpolate(value)])
    )
  };
}

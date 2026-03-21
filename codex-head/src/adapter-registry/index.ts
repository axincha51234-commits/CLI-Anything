import type { AdapterHealth, WorkerTarget } from "../contracts";
import type { CodexHeadConfig } from "../config";
import type { WorkerAdapter } from "./base";
import { ClaudeCodeAdapter } from "./adapters/claudeCode";
import { CodexCliAdapter } from "./adapters/codexCli";
import { GeminiCliAdapter } from "./adapters/geminiCli";
import { AntigravityAdapter } from "./adapters/antigravity";

export class AdapterRegistry {
  private readonly adapters = new Map<WorkerTarget, WorkerAdapter>();

  register(adapter: WorkerAdapter): void {
    this.adapters.set(adapter.capability.worker_target, adapter);
  }

  get(target: WorkerTarget): WorkerAdapter {
    const adapter = this.adapters.get(target);
    if (!adapter) {
      throw new Error(`No adapter registered for ${target}`);
    }
    return adapter;
  }

  has(target: WorkerTarget): boolean {
    return this.adapters.has(target);
  }

  async health(): Promise<AdapterHealth[]> {
    const result: AdapterHealth[] = [];
    for (const adapter of this.adapters.values()) {
      result.push(await adapter.healthCheck());
    }
    return result;
  }
}

export function createDefaultRegistry(config: CodexHeadConfig): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new ClaudeCodeAdapter(config.command_templates["claude-code"]));
  registry.register(new CodexCliAdapter(config.command_templates["codex-cli"]));
  registry.register(new GeminiCliAdapter(config.command_templates["gemini-cli"]));
  registry.register(new AntigravityAdapter(config.command_templates.antigravity));
  return registry;
}

import type { AdapterCapability } from "../../contracts";
import type { WorkerTemplateConfig } from "../../config";
import { BaseWorkerAdapter } from "../base";

const capability: AdapterCapability = {
  worker_target: "claude-code",
  supports_local: true,
  supports_github: false,
  can_edit_code: true,
  can_review: true,
  can_run_tests: true,
  max_concurrency: 2,
  required_binaries: ["claude"],
  feature_flag: null
};

export class ClaudeCodeAdapter extends BaseWorkerAdapter {
  constructor(config: WorkerTemplateConfig) {
    super(capability, config);
  }
}

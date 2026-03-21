import type { AdapterCapability } from "../../contracts";
import type { WorkerTemplateConfig } from "../../config";
import { BaseWorkerAdapter } from "../base";

const capability: AdapterCapability = {
  worker_target: "antigravity",
  supports_local: true,
  supports_github: false,
  can_edit_code: false,
  can_review: true,
  can_run_tests: false,
  max_concurrency: 1,
  required_binaries: ["antigravity"],
  feature_flag: "antigravity"
};

export class AntigravityAdapter extends BaseWorkerAdapter {
  constructor(config: WorkerTemplateConfig) {
    super(capability, config);
  }
}

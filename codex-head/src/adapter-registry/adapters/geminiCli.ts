import type { AdapterCapability } from "../../contracts";
import type { WorkerTemplateConfig } from "../../config";
import { BaseWorkerAdapter } from "../base";

const capability: AdapterCapability = {
  worker_target: "gemini-cli",
  supports_local: true,
  supports_github: true,
  can_edit_code: true,
  can_review: true,
  can_run_tests: false,
  max_concurrency: 3,
  required_binaries: ["gemini"],
  feature_flag: null
};

export class GeminiCliAdapter extends BaseWorkerAdapter {
  constructor(config: WorkerTemplateConfig) {
    super(capability, config);
  }
}

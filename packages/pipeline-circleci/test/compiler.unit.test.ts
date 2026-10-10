import { describe, it } from "vitest";

import { describeCompilerConformance } from "@ci-adapters/pipeline-contract";

import { createCircleCiCompiler } from "../src/index.ts";

describeCompilerConformance({ describe, it }, createCircleCiCompiler, {
  environment: true,
  concurrency: false,
  timeouts: false,
  manualTrigger: false,
});

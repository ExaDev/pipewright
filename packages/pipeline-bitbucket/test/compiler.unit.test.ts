import { describe, it } from "vitest";

import { describeCompilerConformance } from "@pipewright/pipeline-contract";

import { createBitbucketPipelinesCompiler } from "../src/index.ts";

describeCompilerConformance({ describe, it }, createBitbucketPipelinesCompiler, {
  environment: false,
  concurrency: false,
  timeouts: true,
  manualTrigger: true,
});

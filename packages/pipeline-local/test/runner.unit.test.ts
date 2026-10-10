import { describe, it } from "vitest";

import { describeRunnerConformance } from "@ci-adapters/pipeline-contract";

import { createLocalRunner } from "../src/index.ts";

describeRunnerConformance({ describe, it }, createLocalRunner);

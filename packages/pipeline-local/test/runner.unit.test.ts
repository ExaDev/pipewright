import { describe, it } from "vitest";

import { describeRunnerConformance } from "@pipewright/pipeline-contract";

import { createLocalRunner } from "../src/index.ts";

describeRunnerConformance({ describe, it }, createLocalRunner);

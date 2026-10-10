import { describe, it } from "vitest";

import { describeCompilerConformance } from "@ci-adapters/pipeline-contract";

import { createGitHubActionsCompiler } from "../src/index.ts";

describeCompilerConformance({ describe, it }, createGitHubActionsCompiler);

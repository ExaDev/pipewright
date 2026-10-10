import { describe, it } from "vitest";

import { describeCompilerConformance } from "@pipewright/pipeline-contract";

import { createGitHubActionsCompiler } from "../src/index.ts";

describeCompilerConformance({ describe, it }, createGitHubActionsCompiler);

import { describe, it } from "vitest";

import { describeCompilerConformance } from "@pipewright/pipeline-contract";

import { createGitLabCiCompiler } from "../src/index.ts";

describeCompilerConformance({ describe, it }, createGitLabCiCompiler);

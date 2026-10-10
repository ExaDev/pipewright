import { describe, it } from "vitest";

import { describeCompilerConformance } from "@ci-adapters/pipeline-contract";

import { createGitLabCiCompiler } from "../src/index.ts";

describeCompilerConformance({ describe, it }, createGitLabCiCompiler);

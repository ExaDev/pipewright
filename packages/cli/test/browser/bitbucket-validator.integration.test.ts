import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBitbucketPipelinesCompiler } from "@pipewright/pipeline-bitbucket";
import { pipelineSchema, samplePipeline } from "@pipewright/pipeline-contract";

const VALIDATOR_URL = "https://bitbucket.org/product/pipelines/validator";
const VERDICT_TIMEOUT_MS = 30_000;

/** Reads the verdict label the validator page renders: a leaf element whose text is exactly valid or invalid. */
const VERDICT_EXPRESSION = `(() => {
  const labels = [...document.querySelectorAll("div,span")]
    .filter((element) => element.children.length === 0)
    .map((element) => element.textContent.trim().toLowerCase());
  if (labels.includes("invalid")) return "invalid";
  if (labels.includes("valid")) return "valid";
  return null;
})()`;

const FEATURES = { environment: false, concurrency: false, timeouts: true, manualTrigger: true };

let browser: Browser | undefined;

beforeAll(async () => {
  // The installed Google Chrome, not a browser downloaded at test time: a download is bytes this repository cannot verify, and GitHub's runner image already carries Chrome.
  browser = await chromium.launch({ channel: "chrome" });
});

afterAll(async () => {
  await browser?.close();
});

/**
 * Pastes `content` into Atlassian's own validator page and returns its verdict. The page validates in the browser with its own logic, which is not the published JSON Schema, so this is the product's validator and not a stand-in. A fresh page per call keeps one verdict from being read as the next.
 */
async function verdictOf(content: string): Promise<"valid" | "invalid"> {
  if (browser === undefined) throw new Error("the browser did not start");
  const page = await browser.newPage();
  try {
    await page.goto(VALIDATOR_URL);
    await page.waitForSelector(".CodeMirror");
    // The page's own script runs these expressions, so they are strings: this repository's TypeScript has no DOM types and gains none for two lines.
    await page.evaluate(
      `document.querySelector(".CodeMirror").CodeMirror.setValue(${JSON.stringify(content)})`,
    );
    const handle = await page.waitForFunction(VERDICT_EXPRESSION, undefined, {
      timeout: VERDICT_TIMEOUT_MS,
    });
    const verdict = await handle.jsonValue();
    if (verdict !== "valid" && verdict !== "invalid") throw new Error("no verdict was shown");

    return verdict;
  } finally {
    await page.close();
  }
}

async function emitted(features: typeof FEATURES, always: boolean): Promise<string> {
  const pipeline = samplePipeline(features);
  const gate = pipeline.jobs.gate;
  if (gate === undefined) throw new Error("sample lost its gate job");
  if (always) gate.needsPolicy = "always";
  const [file] = await createBitbucketPipelinesCompiler().compile(pipelineSchema.parse(pipeline), {
    source: "ci/sample.pipeline.json",
  });
  if (file === undefined) throw new Error("no file emitted");

  return file.content;
}

describe("Atlassian's own Bitbucket Pipelines validator", () => {
  it("accepts the emitted sample", async () => {
    expect(await verdictOf(await emitted(FEATURES, false))).toBe("valid");
  });

  it("accepts a final step in a custom pipeline, which the published JSON Schema rejects", async () => {
    expect(await verdictOf(await emitted(FEATURES, true))).toBe("valid");
  });

  it("rejects a control with a misspelt keyword", async () => {
    const control =
      "pipelines:\n  default:\n    - step:\n        name: Bad\n        scripts:\n          - echo\n";
    expect(await verdictOf(control)).toBe("invalid");
  });
});

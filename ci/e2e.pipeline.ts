import { SETUP_STEPS } from "./actions.ts";
import {
  context,
  defineJob,
  definePipeline,
  jobsOf,
  matrixJob,
} from "@ci-adapters/pipeline-contract";

const RUNNER = "ubuntu-latest";
const TOOL = "node packages/cli/src/bin.ts";
const PIPELINE_FILE = "ci/e2e.pipeline.ts";
const TIMEOUT_MINUTES = 10;

/**
 * The workflow the end-to-end test dispatches and watches. It exercises the parts of the model a GitHub run can prove: a matrix reaching a step as an environment value, a dependency, a job rendered in the wrapper form so the tool's own runner executes on GitHub, and a gate.
 */

const build = defineJob(
  "build",
  matrixJob({ node: ["22", "24"] }, (axes) => ({
    name: "Build",
    description: "A matrix value reaches the step as an environment value.",
    runsOn: [RUNNER],
    timeoutMinutes: TIMEOUT_MINUTES,
    env: { NODE_AXIS: axes.node, COMMIT: context.sha },
    steps: [
      { kind: "checkout" },
      {
        kind: "run",
        name: "Check the matrix value",
        run: 'test -n "$NODE_AXIS" && test -n "$COMMIT" && echo "axis=$NODE_AXIS"',
      },
    ],
  })),
);

const wrapped = defineJob("wrapped", {
  name: "Wrapped",
  description:
    "Rendered in the wrapper form, so the tool's own runner executes these steps on GitHub.",
  runsOn: [RUNNER],
  timeoutMinutes: TIMEOUT_MINUTES,
  needs: [build],
  form: "wrapper",
  steps: [
    ...SETUP_STEPS,
    {
      kind: "run",
      name: "Run through the tool",
      run: `${TOOL} export --pipeline ${PIPELINE_FILE} > /dev/null && echo wrapped-ok`,
    },
  ],
});

const gate = defineJob("gate", {
  name: "End to end gate",
  runsOn: [RUNNER],
  timeoutMinutes: TIMEOUT_MINUTES,
  needsPolicy: "gate",
  needs: [build, wrapped],
  steps: [{ kind: "run", name: "Report", run: "echo end-to-end-ok" }],
});

export default definePipeline({
  name: "Pipewright end to end",
  description:
    "Dispatched by the end-to-end test, which waits for the run and compares the check names GitHub reports with the ones the compiler derived.",
  triggers: [{ kind: "manual" }],
  permissions: { contents: "read" },
  jobs: jobsOf(build, wrapped, gate),
});

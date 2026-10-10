import { describe, expect, it } from "vitest";

import {
  ImportedPipelineError,
  createReferenceCompiler,
  createReferenceImporter,
  describeImporterConformance,
  samplePipeline,
} from "../src/index.ts";

describeImporterConformance(
  { describe, it },
  () => createReferenceCompiler(),
  () => createReferenceImporter(),
  { rejects: [], wrapperForm: false, distinguishesGate: true, recoversMatrix: true },
);

describe("the reference importer", () => {
  it("reports a value the model rejects with its location in the imported pipeline", async () => {
    const [file] = await createReferenceCompiler().compile(samplePipeline(), { source: "s" });
    if (file === undefined) throw new Error("no file");
    const broken = file.content.replace('"needs": [\n        "lint"\n      ]', '"needs": ["nope"]');

    await expect(createReferenceImporter().import({ ...file, content: broken })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ImportedPipelineError &&
        error.issues[0]?.pointer.startsWith("/jobs/") === true,
    );
  });
});

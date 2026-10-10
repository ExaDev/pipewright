import { z } from "zod";

import { pipelineSchema } from "./schema.ts";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PRIMITIVE_TYPES: ReadonlySet<unknown> = new Set(["string", "number", "integer", "boolean"]);

/**
 * JSON Schema for the resolved model: exactly what `pipelineSchema` accepts, with every required field required.
 */
export function pipelineJsonSchema(): JsonObject {
  // The output side: a TypeScript author may pass a typed reference where the model stores a string, and a JSON document only ever holds the string.
  return z.toJSONSchema(pipelineSchema, { target: "draft-2020-12", io: "output" });
}

function relax(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(relax);
  if (!isObject(node)) return node;

  const relaxed: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    // Fragments are partial documents, so presence is enforced only on the resolved model by the loader.
    if (key === "required") continue;
    relaxed[key] = relax(value);
  }
  if (PRIMITIVE_TYPES.has(relaxed.type) || "enum" in relaxed || "const" in relaxed) {
    return { anyOf: [relaxed, { $ref: "#/$defs/parameterReference" }] };
  }

  return relaxed;
}

/**
 * JSON Schema for an authoring document, the thing an editor validates a `*.pipeline.json` file against. It is the model's schema relaxed for composition: nothing is required (a file may be a fragment), a scalar position may hold a `{"$param": "<name>"}` reference, and the top level gains `extends` and `parameters`. The loader still validates the resolved result against the strict schema, so this one exists for completion and early feedback, not as the arbiter.
 */
export function pipelineAuthoringJsonSchema(): JsonObject {
  const base = relax(pipelineJsonSchema());
  if (!isObject(base)) throw new Error("derived JSON Schema is not an object");
  const properties = isObject(base.properties) ? base.properties : {};
  const defs = isObject(base.$defs) ? base.$defs : {};

  return {
    ...base,
    properties: {
      ...properties,
      extends: {
        description:
          "Fragments this document builds on, by path relative to this file. Merged in order; this file's own content is applied last.",
        anyOf: [
          { $ref: "#/$defs/extendsEntry" },
          { type: "array", items: { $ref: "#/$defs/extendsEntry" } },
        ],
      },
      parameters: {
        description: "Typed parameters this document accepts from the file that extends it.",
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { enum: ["string", "number", "boolean"] },
            default: { type: ["string", "number", "boolean"] },
            description: { type: "string" },
          },
        },
      },
    },
    $defs: {
      ...defs,
      parameterReference: {
        type: "object",
        additionalProperties: false,
        required: ["$param"],
        properties: { $param: { type: "string" } },
      },
      extendsEntry: {
        anyOf: [
          { type: "string" },
          {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: {
              path: { type: "string" },
              with: {
                type: "object",
                additionalProperties: { type: ["string", "number", "boolean"] },
              },
            },
          },
        ],
      },
    },
  };
}

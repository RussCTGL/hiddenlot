import { z } from "zod";

// Converts a zod schema to the JSON Schema subset Meta enforces with
// `strict: true` (https://dev.meta.ai/docs/structured-output):
// plain-object root, no oneOf/allOf, every object closed with all properties
// required, nesting depth <= 10. Nullable is expressed as anyOf (supported
// below the root) rather than a type array, which the docs do not cover.

type JsonSchema = { [key: string]: unknown };

const MAX_DEPTH = 10;

export class StrictSchemaError extends Error {}

export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema) as JsonSchema;
  delete raw.$schema;
  const out = rewriteNullable(raw);
  assertStrict(out, "$", 1, true);
  return out;
}

function rewriteNullable(node: unknown): JsonSchema {
  if (Array.isArray(node)) return node.map(rewriteNullable) as unknown as JsonSchema;
  if (node === null || typeof node !== "object") return node as JsonSchema;

  const obj: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    // `properties` maps names to schemas, so recursing into it rewrites each child.
    obj[key] = key === "enum" || key === "const" ? value : rewriteNullable(value);
  }

  const type = obj.type;
  if (Array.isArray(type) && type.includes("null") && type.length > 1) {
    const nonNull = type.filter((t) => t !== "null");
    const branch: JsonSchema = { ...obj, type: nonNull.length === 1 ? nonNull[0] : nonNull };
    if (Array.isArray(obj.enum)) branch.enum = obj.enum.filter((v) => v !== null);
    return { anyOf: [branch, { type: "null" }] };
  }
  return obj;
}

function assertStrict(node: unknown, path: string, depth: number, isRoot = false): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const obj = node as JsonSchema;

  if (depth > MAX_DEPTH) throw new StrictSchemaError(`${path}: nesting deeper than ${MAX_DEPTH}`);
  if ("oneOf" in obj || "allOf" in obj) throw new StrictSchemaError(`${path}: oneOf/allOf not allowed`);
  if ("$ref" in obj) throw new StrictSchemaError(`${path}: $ref/recursion not allowed`);
  if (isRoot) {
    if (obj.type !== "object") throw new StrictSchemaError("root must be an object");
    for (const k of ["anyOf", "enum", "not"]) {
      if (k in obj) throw new StrictSchemaError(`root must not use ${k}`);
    }
  }

  if (obj.type === "object") {
    const props = (obj.properties ?? {}) as JsonSchema;
    const required = new Set((obj.required ?? []) as string[]);
    if (obj.additionalProperties !== false) {
      throw new StrictSchemaError(`${path}: additionalProperties must be false`);
    }
    for (const key of Object.keys(props)) {
      if (!required.has(key)) {
        throw new StrictSchemaError(`${path}.${key}: optional properties are not allowed; use nullable`);
      }
      assertStrict(props[key], `${path}.${key}`, depth + 1);
    }
  }
  if (obj.items) assertStrict(obj.items, `${path}[]`, depth + 1);
  if (Array.isArray(obj.anyOf)) {
    obj.anyOf.forEach((branch, i) => assertStrict(branch, `${path}|${i}`, depth));
  }
}

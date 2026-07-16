import { toJSONSchema, type ZodType } from "zod";

export type RuntimeJsonSchema = Record<string, unknown>;
export type RuntimeOutputSchema = RuntimeJsonSchema | ZodType;

export function parseJsonOutput<T>(text: string, validator: ((value: unknown) => unknown) | undefined, sourceName: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${sourceName} is not valid JSON for outputSchema`, { cause: error });
  }
  if (validator) {
    return validator(parsed) as T;
  }
  return parsed as T;
}

export function normalizeOptionalOutputSchema(outputSchema: RuntimeOutputSchema | undefined, apiName: string): {
  schema?: RuntimeJsonSchema;
  validator?: (value: unknown) => unknown;
} {
  if (outputSchema === undefined) {
    return {};
  }
  const normalized = normalizeOutputSchema(outputSchema, apiName);
  if (!isPlainJsonObject(normalized.schema)) {
    throw new Error(`${apiName} outputSchema must be a plain JSON object`);
  }
  return normalized;
}

export function normalizeOutputSchema(outputSchema: RuntimeOutputSchema, apiName: string): {
  schema: RuntimeJsonSchema;
  validator?: (value: unknown) => unknown;
} {
  if (isZodSchema(outputSchema)) {
    return {
      schema: toJSONSchema(outputSchema) as RuntimeJsonSchema,
      validator(value: unknown): unknown {
        const result = outputSchema.safeParse(value);
        if (!result.success) {
          throw new Error(`${apiName} JSON output does not match outputSchema: ${result.error.message}`);
        }
        return result.data;
      },
    };
  }
  return { schema: outputSchema };
}

export function isPlainJsonObject(value: unknown): value is RuntimeJsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isZodSchema(value: unknown): value is ZodType {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === "function" &&
    typeof (value as { _zod?: unknown })._zod === "object";
}

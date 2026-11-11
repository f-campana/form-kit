import { z } from "zod";
import { REASON_FIELD, type ContactFormConfig } from "./define";
import type { FieldSpec } from "./fields";

export type ParseResult =
  | { readonly ok: true; readonly reason: string; readonly data: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly fieldErrors: Readonly<Record<string, string>> };

const schemas = (fields: Readonly<Record<string, FieldSpec>>) =>
  Object.fromEntries(Object.entries(fields).map(([name, spec]) => [name, spec.schema]));

/**
 * Validates raw input against the common fields and the chosen reason's
 * fields. Anything else, including other reasons' fields and any attempt to
 * pass recipients, is dropped. Returns one error per field, in plain French.
 */
export function parseSubmission(
  config: ContactFormConfig,
  input: Readonly<Record<string, unknown>>,
): ParseResult {
  const key = input[REASON_FIELD];
  const reasonKey = typeof key === "string" && Object.hasOwn(config.reasons, key) ? key : undefined;
  const reason = reasonKey === undefined ? undefined : config.reasons[reasonKey];

  const shape = { ...schemas(config.commonFields), ...(reason ? schemas(reason.fields) : {}) };
  const result = z.object(shape).safeParse(input);

  const fieldErrors: Record<string, string> = {};
  if (reasonKey === undefined) fieldErrors[REASON_FIELD] = config.reasonError;
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !Object.hasOwn(fieldErrors, field)) {
        fieldErrors[field] = issue.message;
      }
    }
  }
  if (reasonKey === undefined || !result.success) return { ok: false, fieldErrors };

  const data: Record<string, string> = {};
  for (const [name, value] of Object.entries(result.data)) {
    if (typeof value === "string") data[name] = value;
  }
  return { ok: true, reason: reasonKey, data };
}

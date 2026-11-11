import { z } from "zod";

/**
 * A form field: the label used on the page and in emails, and the schema that
 * turns raw input into a trimmed string, or nothing when an optional field is
 * left blank.
 */
export interface FieldSpec {
  readonly label: string;
  readonly schema: z.ZodType;
}

/** Single-line values: whitespace runs, including line breaks, become one space. */
const singleLine = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
};

/** Multi-line values keep their line breaks, normalised to \n. */
const multiLine = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const text = value.replace(/\r\n?/g, "\n").trim();
  return text === "" ? undefined : text;
};

const tooLong = (max: number) => `${max.toLocaleString("fr-FR")} caractères maximum.`;

interface TextOptions {
  readonly max: number;
  /** The error shown when the field is empty. Omit it for an optional field. */
  readonly required?: string;
  readonly multiline?: boolean;
}

export function textField(label: string, options: TextOptions): FieldSpec {
  const clean = options.multiline ? multiLine : singleLine;
  const schema =
    options.required === undefined
      ? z.preprocess(clean, z.string().max(options.max, tooLong(options.max)).optional())
      : z.preprocess(
          clean,
          z.string({ error: options.required }).max(options.max, tooLong(options.max)),
        );
  return { label, schema };
}

interface EmailOptions {
  readonly required: string;
  readonly invalid: string;
}

export function emailField(label: string, options: EmailOptions): FieldSpec {
  const schema = z.preprocess(
    singleLine,
    z
      .email({ error: (issue) => (issue.input === undefined ? options.required : options.invalid) })
      .max(254, options.invalid),
  );
  return { label, schema };
}

interface PhoneOptions {
  readonly invalid: string;
}

/** An optional phone number: digits, spaces, dots, dashes, brackets and a leading +. */
export function phoneField(label: string, options: PhoneOptions): FieldSpec {
  const schema = z.preprocess(
    singleLine,
    z
      .string()
      .max(30, tooLong(30))
      .regex(/^\+?[0-9 ().-]{6,}$/, options.invalid)
      .optional(),
  );
  return { label, schema };
}

interface ChoiceOptions {
  /** The error shown when nothing is chosen. Omit it for an optional field. */
  readonly required?: string;
  /** The error shown when the value isn't one of the options. */
  readonly invalid: string;
}

/** One value from a fixed list, sent as the option's text. */
export function choiceField(
  label: string,
  values: readonly [string, ...string[]],
  options: ChoiceOptions,
): FieldSpec {
  const { required, invalid } = options;
  const schema =
    required === undefined
      ? z.preprocess(singleLine, z.enum(values, { error: invalid }).optional())
      : z.preprocess(
          singleLine,
          z.enum(values, { error: (issue) => (issue.input === undefined ? required : invalid) }),
        );
  return { label, schema };
}

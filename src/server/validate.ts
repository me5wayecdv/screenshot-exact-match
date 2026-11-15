/**
 * Runtime input validation for server functions.
 *
 * Every server function receives its payload from the client, so the
 * TypeScript type on the validator is NOT a runtime guarantee. The old
 * shape — `.validator((data: unknown) => data as { ... })` — trusted
 * the client completely: a missing or wrongly-typed field reached the
 * handler and surfaced as a TypeError ("Cannot read properties of
 * undefined") or a D1 bind error, i.e. an opaque 500 instead of a
 * translated, actionable message.
 *
 * These helpers validate at the boundary and fail with ONE code:
 * INVALID_INPUT, which the i18n error map already translates (see
 * src/lib/i18n.tsx -> errorMap.INVALID_INPUT). A validator failure is
 * a client mistake, not a server fault, so it must never look like a
 * crash.
 *
 * The helpers are intentionally small and total: they return a typed
 * value or throw. No optional chaining surprises, no silent coercion
 * of "undefined" into "0".
 */

/** Thrown by every helper below. The code maps to a translated message. */
export class InputError extends Error {
  readonly code = "INVALID_INPUT";
  constructor(message = "INVALID_INPUT") {
    super(message);
    this.name = "InputError";
  }
}

/** Throw the shared invalid-input error. */
export function invalidInput(): never {
  throw new InputError();
}

/**
 * A payload must be a plain object (not null, not an array). Server
 * functions are always called with an object shape.
 */
export function requireObject(data: unknown): Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) invalidInput();
  return data as Record<string, unknown>;
}

/**
 * A required string. `maxLength` bounds the value so a client cannot
 * push an unbounded blob into a DB column or an AI prompt.
 */
export function requireString(value: unknown, maxLength = 5000): string {
  if (typeof value !== "string" || value.length > maxLength) invalidInput();
  return value;
}

/** An optional string: absent (or null) stays undefined. */
export function optionalString(value: unknown, maxLength = 5000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maxLength) invalidInput();
  return value;
}

/**
 * A required number. `integer` rejects fractional values, `min`/`max`
 * bound the range.
 */
export function requireNumber(
  value: unknown,
  opts: { integer?: boolean; min?: number; max?: number } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidInput();
  if (opts.integer && !Number.isInteger(value)) invalidInput();
  if (opts.min !== undefined && value < opts.min) invalidInput();
  if (opts.max !== undefined && value > opts.max) invalidInput();
  return value;
}

/** An optional number: absent (or null) stays undefined. */
export function optionalNumber(
  value: unknown,
  opts: { integer?: boolean; min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireNumber(value, opts);
}

/** A required boolean. */
export function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalidInput();
  return value;
}

/** An optional boolean: absent (or null) stays undefined. */
export function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalidInput();
  return value;
}

/**
 * A required array of strings. Elements that are not strings fail the
 * whole payload — a mixed array would otherwise reach a `.bind()` as a
 * number and blow up in D1.
 */
export function requireStringArray(value: unknown, maxItems = 500): string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalidInput();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > 500) invalidInput();
    out.push(item);
  }
  return out;
}

/** An optional array of strings: absent (or null) stays undefined. */
export function optionalStringArray(value: unknown, maxItems = 500): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return requireStringArray(value, maxItems);
}

/**
 * A required value from a fixed set (an enum). The returned type is
 * narrowed to the allowed literals.
 */
export function requireEnum<T extends string | number>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" && typeof value !== "number") invalidInput();
  if (!allowed.includes(value as T)) invalidInput();
  return value as T;
}

/** An optional enum value: absent (or null) stays undefined. */
export function optionalEnum<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return requireEnum(value, allowed);
}

/**
 * Drop keys whose value is undefined.
 *
 * Needed because the project compiles with exactOptionalPropertyTypes:
 * `{ limit: undefined }` is NOT assignable to `{ limit?: number }`, so
 * an absent optional field must be omitted from the object, not set
 * to undefined. The return type drops those keys as well, so the
 * result stays assignable to the optional-field target type.
 */
/** The shape produced by compact(): keys whose value may be undefined are gone. */
export type Compacted<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] };

export function compact<T extends Record<string, unknown>>(input: T): Compacted<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as unknown as Compacted<T>;
}

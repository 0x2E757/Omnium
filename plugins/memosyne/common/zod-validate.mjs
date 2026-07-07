// Argument validation that reproduces the prior zod pipeline byte-for-byte.
//
// The pre-Omnium memosyne server declared its tool inputs as zod schemas and
// let the official MCP SDK gate every tools/call; a rejection surfaced to the
// agent as an isError result whose text embeds zod's issue array, e.g.
//
//   MCP error -32602: Input validation error: Invalid arguments for tool
//   memosyne_get_task: [ { "code": "invalid_type", ... } ]
//
// Agents have learned these strings, so they are a frozen compat surface
// (design-ai-engineer §(a) B4) — which is why this module exists INSTEAD of
// the vendored mcp-schema gate: mcp-schema's house-style one-line messages
// would be an observable break here. This is not a general zod replacement;
// it reproduces zod v3's issue collection (all issues, shape-key order, exact
// per-issue key order and message text) for exactly the JSON-schema subset
// the 11 memosyne tools advertise: string(+minLength), string enum,
// integer(+minimum), boolean, array(+maxItems/items) and nested objects.
// This mirrors what the SDK's zod pipeline produced on the wire, so agents
// relying on the exact rejection text keep working.
//
// Non-obvious quirk, observed on the wire: the SDK routed the one EMPTY-shape
// tool (memosyne_project) through a different zod major, so its only failure
// (non-object arguments) uses the v4 issue shape — no `received` key and an
// "Invalid input: expected object, received undefined" message. Reproduced in
// validateEmptyShape below.

/**
 * @typedef {{ [key: string]: unknown }} JsonObject
 * @typedef {{ ok: true, value: unknown } | { ok: false, message: string }} ValidationResult
 */

/**
 * A tool input schema: the frozen draft-07 JSON advertised in tools/list.
 * Only the keywords listed in the header are interpreted.
 * @typedef {object} InputSchema
 * @property {string} [type]
 * @property {string[]} [enum]
 * @property {Record<string, InputSchema>} [properties]
 * @property {string[]} [required]
 * @property {InputSchema} [items]
 * @property {number} [minLength]
 * @property {number} [minimum]
 * @property {number} [maxItems]
 * @property {string} [description] Advertised only; never validated against.
 * @property {boolean} [additionalProperties] Advertised only — zod's default mode STRIPPED unknown keys, so the gate ignores them too.
 * @property {string} [$schema] Advertised only.
 */

/** @typedef {(string | number)[]} IssuePath */

/**
 * True for a plain object — what zod's `"object"` parsed type accepts.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * zod v3's getParsedType, restricted to values that can arrive through a
 * JSON-RPC frame (Map/Set/Date/Promise etc. cannot).
 * @param {unknown} value
 */
function parsedType(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isNaN(value) ? "nan" : "number";
  if (t === "string" || t === "boolean" || t === "bigint" || t === "symbol" || t === "function") return t;
  return "object";
}

/**
 * zod's util.joinValues: enum options quoted and pipe-joined for messages.
 * @param {string[]} values
 */
function joinValues(values) {
  return values.map((v) => `'${v}'`).join(" | ");
}

/**
 * A v3 invalid_type issue for the plain types. Key order (code, expected,
 * received, path, message) and the "Required" special case for a missing
 * value are the frozen wire shape.
 * @param {string} expected
 * @param {unknown} value
 * @param {IssuePath} path
 * @returns {JsonObject}
 */
function invalidType(expected, value, path) {
  const received = parsedType(value);
  return {
    code: "invalid_type",
    expected,
    received,
    path,
    message: received === "undefined" ? "Required" : `Expected ${expected}, received ${received}`,
  };
}

/**
 * A v3 invalid_type issue as ZodEnum emits it — the enum variant leads with
 * `expected` (the quoted option list) instead of `code`.
 * @param {string[]} options
 * @param {unknown} value
 * @param {IssuePath} path
 * @returns {JsonObject}
 */
function invalidEnumType(options, value, path) {
  const received = parsedType(value);
  return {
    expected: joinValues(options),
    received,
    code: "invalid_type",
    path,
    message: received === "undefined" ? "Required" : `Expected ${joinValues(options)}, received ${received}`,
  };
}

/**
 * Validate one value against a (sub)schema, appending every zod issue it
 * would have produced. Mirrors v3 semantics: within a type, checks run in
 * declaration order (.int() before .min(), maxItems before element parsing),
 * and a type mismatch short-circuits that value's remaining checks.
 * @param {InputSchema} schema
 * @param {unknown} value
 * @param {IssuePath} path
 * @param {JsonObject[]} issues
 */
function checkValue(schema, value, path, issues) {
  if (Array.isArray(schema.enum)) {
    if (typeof value !== "string") {
      issues.push(invalidEnumType(schema.enum, value, path));
    } else if (!schema.enum.includes(value)) {
      issues.push({
        received: value,
        code: "invalid_enum_value",
        options: schema.enum,
        path,
        message: `Invalid enum value. Expected ${joinValues(schema.enum)}, received '${value}'`,
      });
    }
    return;
  }
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        issues.push(invalidType("string", value, path));
      } else if (typeof schema.minLength === "number" && value.length < schema.minLength) {
        issues.push({
          code: "too_small",
          minimum: schema.minLength,
          type: "string",
          inclusive: true,
          exact: false,
          message: `String must contain at least ${schema.minLength} character(s)`,
          path,
        });
      }
      return;
    case "integer":
      // zod built these as z.number().int().min(n): the type mismatch names
      // "number", then the int and minimum CHECKS each add their own issue.
      if (typeof value !== "number") {
        issues.push(invalidType("number", value, path));
        return;
      }
      if (!Number.isInteger(value)) {
        issues.push({
          code: "invalid_type",
          expected: "integer",
          received: "float",
          message: "Expected integer, received float",
          path,
        });
      }
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        issues.push({
          code: "too_small",
          minimum: schema.minimum,
          type: "number",
          inclusive: true,
          exact: false,
          message: `Number must be greater than or equal to ${schema.minimum}`,
          path,
        });
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") issues.push(invalidType("boolean", value, path));
      return;
    case "array":
      if (!Array.isArray(value)) {
        issues.push(invalidType("array", value, path));
        return;
      }
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
        issues.push({
          code: "too_big",
          maximum: schema.maxItems,
          type: "array",
          inclusive: true,
          exact: false,
          message: `Array must contain at most ${schema.maxItems} element(s)`,
          path,
        });
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          checkValue(schema.items, value[i], [...path, i], issues);
        }
      }
      return;
    case "object":
      if (!isPlainObject(value)) {
        issues.push(invalidType("object", value, path));
        return;
      }
      checkObject(schema, value, path, issues);
      return;
    default:
      return; // No constraint — nothing zod would have checked.
  }
}

/**
 * The ZodObject walk: shape keys in declaration order, missing optionals
 * skipped, missing required keys parsed as undefined (which yields the
 * "Required" issue of the property's own type). Unknown keys are ignored —
 * zod's default "strip" mode never errored on them.
 * @param {InputSchema} schema
 * @param {Record<string, unknown>} value
 * @param {IssuePath} path
 * @param {JsonObject[]} issues
 */
function checkObject(schema, value, path, issues) {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  for (const [key, propSchema] of Object.entries(properties)) {
    const propValue = value[key];
    if (propValue === undefined && !required.includes(key)) continue;
    checkValue(propSchema, propValue, [...path, key], issues);
  }
}

/**
 * The v4-shaped gate for the empty-shape tool (see header). Only a non-object
 * argument bag can fail it.
 * @param {unknown} args
 * @returns {JsonObject[]}
 */
function validateEmptyShape(args) {
  if (isPlainObject(args)) return [];
  return [
    {
      expected: "object",
      code: "invalid_type",
      path: [],
      message: `Invalid input: expected object, received ${parsedType(args)}`,
    },
  ];
}

/**
 * Gate one tools/call exactly as the prior zod pipeline did. Returns the
 * arguments unchanged on success (zod's key-stripping is unobservable — the
 * handlers only read declared properties), or the frozen failure text.
 * Plugs into the shared core as ToolSpec.validate.
 * @param {string} toolName
 * @param {InputSchema} schema
 * @param {unknown} args
 * @returns {ValidationResult}
 */
export function validateToolArguments(toolName, schema, args) {
  /** @type {JsonObject[]} */
  let issues;
  if (Object.keys(schema.properties ?? {}).length === 0) {
    issues = validateEmptyShape(args);
  } else if (!isPlainObject(args)) {
    issues = [invalidType("object", args, [])];
  } else {
    issues = [];
    checkObject(schema, args, [], issues);
  }
  if (issues.length === 0) return { ok: true, value: args };
  return {
    ok: false,
    message:
      `MCP error -32602: Input validation error: Invalid arguments for tool ${toolName}: ` +
      JSON.stringify(issues, null, 2),
  };
}

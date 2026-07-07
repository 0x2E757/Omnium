// VENDORED SHARED MODULE — canonical copy: shared/mcp-schema.mjs. Do not edit any plugins/*/common/ copy; edit shared/ and run: node scripts/sync-shared.mjs
//
// Minimal JSON-Schema-subset validator for MCP tool arguments. The shared
// stdio core (mcp-core.mjs, its sibling) runs this on every tools/call before
// the tool handler executes. It exists so the plugins stay zero-dependency —
// no zod, no ajv — while still gating malformed arguments at the transport
// edge. Supported keywords: type (string/integer/number/boolean/array/object),
// required, properties, enum, items, minLength, minimum, maximum. Unknown
// keywords are ignored, because advertised inputSchema objects are frozen
// compat surfaces and may carry keywords (description, ...) no gate needs.
//
// Non-obvious decision: rejection messages use the exact sentence pattern
// "Missing or invalid '<name>' (expected <phrase>)." because that is the
// wording expertum's handler has always produced for bad arguments — on the
// wire, the gate must be indistinguishable from the prior in-handler checks.

/**
 * @typedef {object} JsonSchema
 * @property {string} [type]
 * @property {unknown[]} [enum]
 * @property {Record<string, JsonSchema>} [properties]
 * @property {string[]} [required]
 * @property {JsonSchema} [items]
 * @property {number} [minLength]
 * @property {number} [minimum]
 * @property {number} [maximum]
 */

/**
 * @typedef {{ ok: true, value: unknown } | { ok: false, message: string }} ValidationResult
 */

/**
 * True for a plain object — the only shape `"type": "object"` accepts.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectLike(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Human phrase (article included) for what a schema expects, used in
 * rejection messages. Bound violations (minLength/minimum/maximum) reuse the
 * base phrase — except a string with minLength >= 1, which reads
 * "a non-empty string" to match expertum's frozen handler message.
 * @param {JsonSchema} schema
 */
function expectedPhrase(schema) {
  if (Array.isArray(schema.enum)) {
    return "one of " + schema.enum.map((v) => JSON.stringify(v)).join(", ");
  }
  switch (schema.type) {
    case "string":
      return typeof schema.minLength === "number" && schema.minLength >= 1
        ? "a non-empty string"
        : "a string";
    case "integer": return "an integer";
    case "number": return "a number";
    case "boolean": return "a boolean";
    case "array": return "an array";
    case "object": return "an object";
    default: return "a value";
  }
}

/**
 * The one rejection message shape (see the header for why it is frozen).
 * @param {string} name
 * @param {JsonSchema | undefined} schema
 */
function invalid(name, schema) {
  return "Missing or invalid '" + name + "' (expected " + expectedPhrase(schema || {}) + ").";
}

/**
 * Check one value against a (sub)schema. Returns a rejection message, or null
 * when the value is acceptable. `name` is the property path used in the
 * message ("filename", "tags[0]", "meta.name", ...).
 * @param {JsonSchema} schema
 * @param {unknown} value
 * @param {string} name
 * @returns {string | null}
 */
function checkValue(schema, value, name) {
  if (Array.isArray(schema.enum)) {
    return schema.enum.some((allowed) => allowed === value) ? null : invalid(name, schema);
  }
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") return invalid(name, schema);
      if (typeof schema.minLength === "number" && value.length < schema.minLength) {
        return invalid(name, schema);
      }
      return null;
    case "integer":
    case "number": {
      if (typeof value !== "number") return invalid(name, schema);
      if (schema.type === "integer" && !Number.isInteger(value)) return invalid(name, schema);
      if (typeof schema.minimum === "number" && value < schema.minimum) return invalid(name, schema);
      if (typeof schema.maximum === "number" && value > schema.maximum) return invalid(name, schema);
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : invalid(name, schema);
    case "array": {
      if (!Array.isArray(value)) return invalid(name, schema);
      if (isObjectLike(schema.items)) {
        for (let i = 0; i < value.length; i++) {
          const message = checkValue(schema.items, value[i], name + "[" + i + "]");
          if (message !== null) return message;
        }
      }
      return null;
    }
    case "object":
      if (!isObjectLike(value)) return invalid(name, schema);
      return checkProperties(schema, value, name + ".");
    default:
      return null; // No type constraint — anything goes.
  }
}

/**
 * required/properties walk, shared by the root call and nested objects.
 * Properties are walked in declaration order so the first-listed property
 * wins the message — the same order the prior handlers checked arguments in.
 * @param {JsonSchema} schema
 * @param {Record<string, unknown>} obj
 * @param {string} prefix property-path prefix ("" at the root, "meta." nested)
 * @returns {string | null}
 */
function checkProperties(schema, obj, prefix) {
  const properties = isObjectLike(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const [key, propSchema] of Object.entries(properties)) {
    const value = obj[key];
    if (value === undefined) {
      if (required.includes(key)) return invalid(prefix + key, propSchema);
      continue;
    }
    const message = checkValue(propSchema, value, prefix + key);
    if (message !== null) return message;
  }
  // A required key without a matching properties entry still has to exist.
  for (const key of required) {
    if (!(key in properties) && obj[key] === undefined) return invalid(prefix + key, undefined);
  }
  return null;
}

/**
 * Validate MCP tool-call arguments against a tool's validation schema.
 * Returns { ok: true, value } echoing the input unchanged (no coercion, no
 * defaults) or { ok: false, message } with the first rejection found.
 *
 * Non-object arguments for an object schema are treated as an empty object —
 * mirroring the prior servers' `args || {}` tolerance — so a rejection always
 * names a concrete missing property rather than the argument bag itself.
 * @param {JsonSchema | undefined} schema
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validateInput(schema, value) {
  if (!isObjectLike(schema)) return { ok: true, value }; // No schema — no gate.
  let message;
  if (schema.type === "object" || isObjectLike(schema.properties)) {
    message = checkProperties(schema, isObjectLike(value) ? value : {}, "");
  } else {
    message = checkValue(schema, value, "arguments");
  }
  return message === null ? { ok: true, value } : { ok: false, message };
}

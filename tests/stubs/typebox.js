/**
 * typebox test stub.
 *
 * The real `typebox` package ships ESM that ts-jest/jest cannot parse out of
 * the box. The pi surface only uses `Type.*` builders to construct schema
 * objects that describe tools to the LLM — core never validates against them.
 * This stub returns plain descriptor objects with the same builder surface,
 * which is all the tests (and pi at runtime, against the real package) need.
 */
const wrap = (type) => (opts) => ({ type, ...(opts || {}) });

const Type = {
  Object: (properties = {}, opts) => ({ type: 'object', properties, ...(opts || {}) }),
  String: wrap('string'),
  Number: wrap('number'),
  Boolean: wrap('boolean'),
  Any: wrap('any'),
  Array: (items, opts) => ({ type: 'array', items, ...(opts || {}) }),
  Record: (key, val, opts) => ({ type: 'object', ...(opts || {}) }),
  Optional: (schema) => ({ ...(schema || {}), optional: true }),
  Union: (anyOf, opts) => ({ type: 'union', anyOf, ...(opts || {}) }),
  Literal: (constValue) => ({ type: 'literal', const: constValue })
};

module.exports = { Type };

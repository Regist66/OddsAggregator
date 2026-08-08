import assert from "node:assert/strict";
import test from "node:test";

import { numericOption, validateNamedArguments } from "../src/numeric_config.js";

test("numeric configuration accepts values inside its declared range", () => {
  assert.equal(numericOption("30", "markets", { integer: true, min: 1, max: 200 }), 30);
  assert.equal(numericOption("0.5", "ratio", { min: 0, max: 1 }), 0.5);
});

test("numeric configuration rejects non-finite, fractional and out-of-range values", () => {
  assert.throws(() => numericOption("NaN", "value"), /Érvénytelen/);
  assert.throws(() => numericOption("1.5", "count", { integer: true }), /Érvénytelen/);
  assert.throws(() => numericOption("0", "count", { min: 1 }), /Érvénytelen/);
});

test("CLI validation rejects unknown and missing named arguments", () => {
  assert.doesNotThrow(() => validateNamedArguments(["duration"], ["--duration", "2"]));
  assert.throws(
    () => validateNamedArguments(["duration"], ["--duraton", "2"]),
    /Ismeretlen CLI kapcsoló/,
  );
  assert.throws(
    () => validateNamedArguments(["duration"], ["--duration"]),
    /Hiányzó érték/,
  );
  assert.throws(
    () => validateNamedArguments(["duration"], ["--duration", "1", "--duration", "2"]),
    /Dupla CLI kapcsoló/,
  );
  assert.doesNotThrow(() =>
    validateNamedArguments(["duration", "once"], ["--once", "--duration", "2"], ["once"]),
  );
});

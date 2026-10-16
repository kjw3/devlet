import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNumericDraft } from "../src/lib/number-input.js";

test("parseNumericDraft allows full clearing (no undeletable zero)", () => {
  assert.deepEqual(parseNumericDraft(""), { text: "", value: 0 });
});

test("parseNumericDraft strips leading zeros so 01 can never be displayed", () => {
  assert.deepEqual(parseNumericDraft("01"), { text: "1", value: 1 });
  assert.deepEqual(parseNumericDraft("007"), { text: "7", value: 7 });
  assert.deepEqual(parseNumericDraft("010"), { text: "10", value: 10 });
});

test("parseNumericDraft keeps a lone zero and normal numbers", () => {
  assert.deepEqual(parseNumericDraft("0"), { text: "0", value: 0 });
  assert.deepEqual(parseNumericDraft("12"), { text: "12", value: 12 });
  assert.deepEqual(parseNumericDraft("100"), { text: "100", value: 100 });
});

test("parseNumericDraft ignores non-digit input", () => {
  assert.deepEqual(parseNumericDraft("abc"), { text: "", value: 0 });
  assert.deepEqual(parseNumericDraft("1e5"), { text: "15", value: 15 });
  assert.deepEqual(parseNumericDraft("a2b0c1"), { text: "201", value: 201 });
});

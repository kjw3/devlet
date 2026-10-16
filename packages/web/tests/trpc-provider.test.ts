import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { TrpcProvider } from "../src/trpc.js";

test("TrpcProvider renders children exactly once (both lanes nested, not siblings)", () => {
  const Marker = () => React.createElement("div", { "data-marker": "unique-child" });
  const html = renderToString(
    React.createElement(TrpcProvider, null, React.createElement(Marker))
  );
  const count = (html.match(/data-marker="unique-child"/g) ?? []).length;
  // Regression: providers were previously rendered as siblings, each receiving
  // children — duplicating the whole app on screen.
  assert.equal(count, 1);
});

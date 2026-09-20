import * as assert from "assert";
import { parseTestGrep } from "../runTest";

suite("Test Runner Arguments", () => {
  test("no arguments selects the full suite", () => {
    assert.strictEqual(parseTestGrep([]), undefined);
  });

  test("grep accepts long, short and equals forms without changing the pattern", () => {
    for (const args of [
      ["--grep", "tabs|claim"],
      ["-g", "tabs|claim"],
      ["--grep=tabs|claim"],
    ]) {
      assert.strictEqual(parseTestGrep(args), "tabs|claim");
    }
  });

  test("invalid or ambiguous arguments fail instead of silently running everything", () => {
    for (const args of [
      ["--grep"],
      ["--grep", ""],
      ["--grep", "   "],
      ["--grep", "["],
      ["--unknown"],
      ["unrecognized-positional"],
    ]) {
      assert.throws(() => parseTestGrep(args), args.join(" "));
    }
  });
});

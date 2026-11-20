import * as assert from "assert";
import {
  AGENT_HOST_OBSERVATION_CAP_MS,
  parseTaskTimeout,
  resolveAgentHostTimeout,
  resolveCliTimeout,
} from "../../agentHostTimeout";

type Config = Parameters<typeof resolveAgentHostTimeout>[0];
type Inspected = Record<string, Record<string, unknown>>;

function configWith(values: Record<string, unknown>, inspected: Inspected = {}): Config {
  return {
    get: <T>(key: string, fallback?: T): T =>
      (Object.hasOwn(values, key) ? values[key] : fallback) as T,
    inspect: (key: string) => ({ key, ...(inspected[key] ?? {}) }),
  } as unknown as Config;
}

const MINUTE = 60 * 1000;

suite("Agent Host timeout settings", () => {
  test("is off by default and watches a queued message for a bounded time", () => {
    const result = resolveAgentHostTimeout(configWith({}));
    assert.strictEqual(result.runMs, undefined);
    assert.strictEqual(result.observationMs, AGENT_HOST_OBSERVATION_CAP_MS);
  });

  test("turning it on uses 180 minutes unless the minutes are set", () => {
    const enabled = { agentHostTimeoutEnabled: { globalValue: true } };
    const on = resolveAgentHostTimeout(configWith({ agentHostTimeoutEnabled: true }, enabled));
    assert.strictEqual(on.runMs, 180 * MINUTE);
    assert.strictEqual(on.observationMs, 180 * MINUTE);
    const custom = resolveAgentHostTimeout(
      configWith({ agentHostTimeoutEnabled: true, agentHostTimeoutMinutes: 45 }, enabled),
    );
    assert.strictEqual(custom.runMs, 45 * MINUTE);
  });

  test("minutes set before the option existed keep the timeout on", () => {
    const result = resolveAgentHostTimeout(
      configWith({ agentHostTimeoutMinutes: 90 }, { agentHostTimeoutMinutes: { globalValue: 90 } }),
    );
    assert.strictEqual(result.runMs, 90 * MINUTE);
  });

  test("an explicit off wins over the minutes, and a workspace value is not honored", () => {
    const off = resolveAgentHostTimeout(
      configWith(
        { agentHostTimeoutEnabled: false, agentHostTimeoutMinutes: 90 },
        {
          agentHostTimeoutEnabled: { globalValue: false },
          agentHostTimeoutMinutes: { globalValue: 90 },
        },
      ),
    );
    assert.strictEqual(off.runMs, undefined);
    const workspaceOnly = resolveAgentHostTimeout(
      configWith(
        { agentHostTimeoutEnabled: true, agentHostTimeoutMinutes: 5 },
        {
          agentHostTimeoutEnabled: { workspaceValue: true },
          agentHostTimeoutMinutes: { workspaceValue: 5 },
        },
      ),
    );
    assert.strictEqual(workspaceOnly.runMs, undefined);
  });

  test("invalid or out-of-range minutes fall back to the default or the limits", () => {
    const enabled = { agentHostTimeoutEnabled: { globalValue: true } };
    const minutes = (value: unknown) =>
      resolveAgentHostTimeout(
        configWith({ agentHostTimeoutEnabled: true, agentHostTimeoutMinutes: value }, enabled),
      ).runMs;
    assert.strictEqual(minutes(5000), 720 * MINUTE);
    assert.strictEqual(minutes(2.9), 2 * MINUTE);
    for (const invalid of [0, -3, Number.NaN, "abc", undefined]) {
      assert.strictEqual(minutes(invalid), 180 * MINUTE, String(invalid));
    }
  });
});

suite("Task timeout override", () => {
  test("parseTaskTimeout accepts the three modes and rejects everything else", () => {
    assert.deepStrictEqual(parseTaskTimeout(undefined), { ok: true, value: undefined });
    assert.deepStrictEqual(parseTaskTimeout({ mode: "inherit", minutes: 5 }), { ok: true, value: undefined });
    assert.deepStrictEqual(parseTaskTimeout({ mode: "off", minutes: 5 }), { ok: true, value: { mode: "off" } });
    assert.deepStrictEqual(parseTaskTimeout({ mode: "on" }), { ok: true, value: { mode: "on" } });
    assert.deepStrictEqual(parseTaskTimeout({ mode: "on", minutes: 45 }), { ok: true, value: { mode: "on", minutes: 45 } });
    for (const invalid of [
      null, "on", 5, [], {}, { mode: "later" },
      { mode: "on", minutes: 0 }, { mode: "on", minutes: 721 }, { mode: "on", minutes: 1.5 },
      { mode: "on", minutes: "30" }, { mode: "on", minutes: null },
    ]) {
      assert.deepStrictEqual(parseTaskTimeout(invalid), { ok: false }, JSON.stringify(invalid));
    }
  });

  test("a task override beats the settings for both routes", () => {
    const enabled = { agentHostTimeoutEnabled: { globalValue: true }, cliTimeoutEnabled: { globalValue: true } };
    const on = configWith({ agentHostTimeoutEnabled: true, cliTimeoutEnabled: true, agentHostTimeoutMinutes: 90, cliTimeoutMinutes: 90 }, enabled);
    const off = configWith({});
    // Off for the task wins over an enabled setting.
    assert.strictEqual(resolveAgentHostTimeout(on, { mode: "off" }).runMs, undefined);
    assert.strictEqual(resolveAgentHostTimeout(on, { mode: "off" }).observationMs, AGENT_HOST_OBSERVATION_CAP_MS);
    assert.strictEqual(resolveCliTimeout(on, { mode: "off" }).runMs, undefined);
    // On for the task wins over a disabled setting; minutes default to the configured ones.
    assert.strictEqual(resolveAgentHostTimeout(off, { mode: "on", minutes: 20 }).runMs, 20 * MINUTE);
    assert.strictEqual(resolveCliTimeout(off, { mode: "on", minutes: 20 }).runMs, 20 * MINUTE);
    assert.strictEqual(resolveCliTimeout(off, { mode: "on" }).runMs, 180 * MINUTE);
    assert.strictEqual(resolveAgentHostTimeout(on, { mode: "on" }).runMs, 90 * MINUTE);
    // The same override applies to both routes and reports where it came from.
    assert.strictEqual(resolveAgentHostTimeout(off, { mode: "on", minutes: 20 }).viaTask, true);
    assert.strictEqual(resolveCliTimeout(off, undefined).viaTask, false);
  });

  test("an invalid stored value is ignored so the settings apply", () => {
    const on = configWith({ cliTimeoutEnabled: true }, { cliTimeoutEnabled: { globalValue: true } });
    for (const stored of [{ mode: "on", minutes: 9999 }, { mode: "bogus" }, "off", null]) {
      const resolved = resolveCliTimeout(on, stored as never);
      assert.strictEqual(resolved.runMs, 180 * MINUTE);
      assert.strictEqual(resolved.viaTask, false);
      assert.strictEqual(resolveAgentHostTimeout(configWith({}), stored as never).runMs, undefined);
    }
  });
});

suite("Copilot CLI timeout settings", () => {
  test("is off by default and reports 180 minutes for the message", () => {
    assert.deepStrictEqual(resolveCliTimeout(configWith({})), {
      runMs: undefined,
      minutes: 180,
      viaTask: false,
    });
  });

  test("follows the CLI option and keeps a timeout the user set before the option existed", () => {
    const on = resolveCliTimeout(
      configWith(
        { cliTimeoutEnabled: true, cliTimeoutMinutes: 30 },
        { cliTimeoutEnabled: { globalValue: true } },
      ),
    );
    assert.strictEqual(on.runMs, 30 * MINUTE);
    const legacy = resolveCliTimeout(
      configWith({ cliTimeoutMinutes: 60 }, { cliTimeoutMinutes: { globalValue: 60 } }),
    );
    assert.strictEqual(legacy.runMs, 60 * MINUTE);
    const off = resolveCliTimeout(
      configWith(
        { cliTimeoutEnabled: false, cliTimeoutMinutes: 60 },
        { cliTimeoutEnabled: { globalValue: false }, cliTimeoutMinutes: { globalValue: 60 } },
      ),
    );
    assert.strictEqual(off.runMs, undefined);
  });

  test("does not read the Agent Host settings", () => {
    const result = resolveCliTimeout(
      configWith(
        { agentHostTimeoutEnabled: true, agentHostTimeoutMinutes: 5 },
        { agentHostTimeoutEnabled: { globalValue: true }, agentHostTimeoutMinutes: { globalValue: 5 } },
      ),
    );
    assert.strictEqual(result.runMs, undefined);
  });
});

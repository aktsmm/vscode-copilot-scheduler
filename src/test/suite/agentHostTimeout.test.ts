import * as assert from "assert";
import {
  AGENT_HOST_OBSERVATION_CAP_MS,
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

suite("Copilot CLI timeout settings", () => {
  test("is off by default and reports 180 minutes for the message", () => {
    assert.deepStrictEqual(resolveCliTimeout(configWith({})), {
      runMs: undefined,
      minutes: 180,
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

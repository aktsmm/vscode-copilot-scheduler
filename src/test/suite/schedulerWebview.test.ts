import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { SchedulerWebview } from "../../schedulerWebview";
import { messages } from "../../i18n";
import type { PromptPreview, ScheduledTask } from "../../types";
import {
  runSanitizerParityCases,
  runSharedSanitizerCases,
} from "./helpers/sanitizerAssertions";

type WebviewLike = {
  postMessage: (message: unknown) => Thenable<boolean>;
};

type WebviewPanelLike = {
  webview: WebviewLike;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sourceContainsToken(source: string, token: string): boolean {
  return normalizeWhitespace(source).includes(normalizeWhitespace(token));
}

function assertTokensInOrder(
  source: string,
  tokens: string[],
  messagePrefix: string,
): void {
  const normalizedSource = normalizeWhitespace(source);
  let cursor = 0;
  for (const token of tokens) {
    const normalizedToken = normalizeWhitespace(token);
    const index = normalizedSource.indexOf(normalizedToken, cursor);
    assert.ok(index >= 0, `${messagePrefix}: ${token}`);
    cursor = index + normalizedToken.length;
  }
}

function findMatchingBraceEnd(source: string, braceStart: number): number {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inSingleQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (inTemplate) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "`") {
        inTemplate = false;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (ch === "`") {
      inTemplate = true;
      continue;
    }

    if (ch === "{") {
      depth++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return -1;
}

function extractBlockFromStartToken(
  source: string,
  startToken: string,
): string {
  const start = source.indexOf(startToken);
  assert.ok(start >= 0, `Start token not found: ${startToken}`);

  const braceStart = source.indexOf("{", start);
  assert.ok(braceStart >= 0, `Opening brace not found for: ${startToken}`);

  let end = findMatchingBraceEnd(source, braceStart);
  if (end <= braceStart) {
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
  }

  assert.ok(end > braceStart, `Closing brace not found for: ${startToken}`);
  return source.slice(start, end);
}

function extractFunctionSource(source: string, functionName: string): string {
  const signatures = [
    `function ${functionName}(`,
    `export function ${functionName}(`,
  ];
  let start = -1;
  for (const signature of signatures) {
    start = source.indexOf(signature);
    if (start >= 0) {
      break;
    }
  }
  assert.ok(
    start >= 0,
    `Function not found in webview script: ${functionName}`,
  );

  const braceStart = source.indexOf("{", start);
  assert.ok(
    braceStart >= 0,
    `Function opening brace not found for: ${functionName}`,
  );

  let depth = 0;
  let end = -1;
  for (let index = braceStart; index < source.length; index++) {
    const ch = source[index];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }

  assert.ok(
    end > braceStart,
    `Function closing brace not found for: ${functionName}`,
  );
  return source.slice(start, end);
}

function extractStringAwareFunctionSource(
  source: string,
  functionName: string,
): string {
  const start = source.indexOf(`function ${functionName}(`);
  assert.ok(
    start >= 0,
    `Function not found in webview script: ${functionName}`,
  );

  const braceStart = source.indexOf("{", start);
  assert.ok(
    braceStart >= 0,
    `Function opening brace not found for: ${functionName}`,
  );

  const end = findMatchingBraceEnd(source, braceStart);
  assert.ok(
    end > braceStart,
    `Function closing brace not found for: ${functionName}`,
  );
  return source.slice(start, end);
}

function extractVarAssignment(source: string, varName: string): string {
  // Escape varName so that special regex characters don't cause mismatches.
  const escapedName = varName.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`var\\s+${escapedName}\\s*=\\s*[^;]+;`);
  const match = source.match(pattern);
  assert.ok(
    match?.[0],
    `Variable assignment not found in webview script: ${varName}`,
  );
  return match![0];
}

function loadWebviewSanitizeFunction(
  redactedPlaceholder = "[REDACTED]",
): (message: string) => string {
  const scriptPath = path.resolve(
    __dirname,
    "../../../media/schedulerWebview.js",
  );
  const source = fs.readFileSync(scriptPath, "utf8");

  const snippet = [
    extractVarAssignment(source, "MAX_SANITIZE_OUTPUT_CHARS"),
    extractVarAssignment(source, "MAX_SANITIZE_INPUT_CHARS"),
    extractVarAssignment(source, "REDACTED_PLACEHOLDER"),
    extractFunctionSource(source, "basenameAny"),
    extractFunctionSource(source, "basenameFromPathLike"),
    extractFunctionSource(source, "sanitizeSensitiveDetails"),
    extractFunctionSource(source, "sanitizeAbsolutePaths"),
    "REDACTED_PLACEHOLDER = __redactedPlaceholder;",
    "return sanitizeAbsolutePaths;",
  ].join("\n");

  const factory = new Function("URL", "__redactedPlaceholder", snippet) as (
    urlCtor: typeof URL,
    placeholder: string,
  ) => (message: string) => string;

  return factory(URL, redactedPlaceholder);
}

function loadWebviewStrictIntervalCronFunction(): (
  totalMinutes: number,
) => string {
  const scriptPath = path.resolve(
    __dirname,
    "../../../media/schedulerWebview.js",
  );
  const source = fs.readFileSync(scriptPath, "utf8");

  const snippet = [
    extractFunctionSource(source, "buildStrictIntervalCron"),
    "return buildStrictIntervalCron;",
  ].join("\n");

  const factory = new Function(snippet) as () => (
    totalMinutes: number,
  ) => string;
  return factory();
}

function loadWebviewFriendlyCronExpressionFunction(): (values: {
  selection?: string;
  interval?: string | number;
  minute?: string | number;
  hour?: string | number;
  dow?: string | number;
  dom?: string | number;
}) => string | null {
  const scriptPath = path.resolve(
    __dirname,
    "../../../media/schedulerWebview.js",
  );
  const source = fs.readFileSync(scriptPath, "utf8");

  const snippet = [
    extractFunctionSource(source, "boundedNumber"),
    extractStringAwareFunctionSource(source, "buildStrictIntervalCron"),
    extractStringAwareFunctionSource(source, "buildFriendlyCronExpression"),
    "return buildFriendlyCronExpression;",
  ].join("\n");

  const factory = new Function(snippet) as () => (values: {
    selection?: string;
    interval?: string | number;
    minute?: string | number;
    hour?: string | number;
    dow?: string | number;
    dom?: string | number;
  }) => string | null;
  return factory();
}

function loadWebviewCronSummaryFunction(): (expression: string) => string {
  const scriptPath = path.resolve(
    __dirname,
    "../../../media/schedulerWebview.js",
  );
  const source = fs.readFileSync(scriptPath, "utf8");

  const strings = {
    daySun: messages.daySun(),
    dayMon: messages.dayMon(),
    dayTue: messages.dayTue(),
    dayWed: messages.dayWed(),
    dayThu: messages.dayThu(),
    dayFri: messages.dayFri(),
    daySat: messages.daySat(),
    labelFriendlyFallback: messages.labelFriendlyFallback(),
    cronPreviewEveryNMinutes: messages.cronPreviewEveryNMinutes(),
    cronPreviewEveryHour: messages.cronPreviewEveryHour(),
    cronPreviewEveryNHours: messages.cronPreviewEveryNHours(),
    cronPreviewMultipleExpressions: messages.cronPreviewMultipleExpressions(),
    cronPreviewHourlyAtMinute: messages.cronPreviewHourlyAtMinute(),
    cronPreviewDailyAt: messages.cronPreviewDailyAt(),
    cronPreviewWeekdaysAt: messages.cronPreviewWeekdaysAt(),
    cronPreviewWeeklyOnAt: messages.cronPreviewWeeklyOnAt(),
    cronPreviewMonthlyOnAt: messages.cronPreviewMonthlyOnAt(),
  };
  const friendlyIntervalMinutes = [
    1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 16, 18, 20, 24, 30, 32, 36, 40, 45, 48,
    60, 72, 80, 90, 96, 120, 180, 240, 360, 480, 720, 1440,
  ];

  const snippet = [
    "var strings = __strings;",
    "var friendlyIntervalMinutes = __friendlyIntervalMinutes;",
    extractVarAssignment(source, "dayNames"),
    extractFunctionSource(source, "padNumber"),
    extractFunctionSource(source, "normalizeDow"),
    extractFunctionSource(source, "formatTime"),
    extractFunctionSource(source, "splitCronLines"),
    extractFunctionSource(source, "normalizeCronExpressionForCompare"),
    extractStringAwareFunctionSource(source, "formatIntervalLabel"),
    extractStringAwareFunctionSource(source, "buildStrictIntervalCron"),
    extractStringAwareFunctionSource(source, "getStrictIntervalSummary"),
    extractStringAwareFunctionSource(source, "getCronSummary"),
    "return getCronSummary;",
  ].join("\n");

  const factory = new Function(
    "__strings",
    "__friendlyIntervalMinutes",
    snippet,
  ) as (
    webviewStrings: typeof strings,
    intervals: number[],
  ) => (expression: string) => string;
  return factory(strings, friendlyIntervalMinutes);
}

suite("SchedulerWebview Attachment Root Tests", () => {
  const webviewSourcePath = path.resolve(
    __dirname,
    "../../../src/schedulerWebview.ts",
  );

  test("attachment picker offers only the folder the task binds to", () => {
    const source = fs.readFileSync(webviewSourcePath, "utf8");

    assert.ok(
      sourceContainsToken(
        source,
        "const boundPath = this.resolveBoundWorkspacePath(taskId);",
      ),
      "getAttachmentRoots must resolve the bound workspace folder",
    );
    assert.ok(
      !/for \(const folder of vscode\.workspace\.workspaceFolders \?\? \[\]\) \{\s*roots\.push/.test(
        source,
      ),
      "the picker must not offer every workspace folder as a local root",
    );
    assert.ok(
      sourceContainsToken(
        source,
        'return task.scope === "workspace" ? task.workspacePath : undefined;',
      ),
      "a global task must not expose a local attachment root",
    );
  });

  test("attachment messages carry the edited task id", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");
    const occurrences = source.match(/taskId: editingTaskId \|\| undefined/g);

    assert.ok(
      occurrences && occurrences.length >= 3,
      "pick, browse, and open attachment messages must all send the task id",
    );
  });

  test("preferred workspace resolution lives in a single module", () => {
    const srcRoot = path.resolve(__dirname, "../../../src");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "test") {
            walk(full);
          }
          continue;
        }
        if (!entry.name.endsWith(".ts")) {
          continue;
        }
        if (entry.name === "workspaceRoots.ts") {
          continue;
        }
        if (
          fs
            .readFileSync(full, "utf8")
            .includes("activeTextEditor?.document.uri")
        ) {
          offenders.push(entry.name);
        }
      }
    };

    walk(srcRoot);

    assert.deepStrictEqual(
      offenders,
      [],
      "preferred workspace folder resolution must stay in workspaceRoots.ts",
    );
  });

  test("attachment chips render, remove the picked row and honor the limit", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    type StubElement = {
      tagName: string;
      className: string;
      type?: string;
      textContent: string;
      innerHTML: string;
      style: { display: string };
      children: StubElement[];
      attrs: Map<string, string>;
      listeners: Map<string, Array<() => void>>;
      setAttribute(name: string, value: string): void;
      appendChild(child: StubElement): void;
      addEventListener(event: string, handler: () => void): void;
      click(): void;
      focus(): void;
    };

    const focused: StubElement[] = [];
    const makeElement = (tagName: string): StubElement => {
      const element: StubElement = {
        tagName,
        className: "",
        textContent: "",
        innerHTML: "",
        style: { display: "" },
        children: [],
        attrs: new Map<string, string>(),
        listeners: new Map<string, Array<() => void>>(),
        setAttribute: (name, value) => void element.attrs.set(name, value),
        appendChild: (child) => {
          element.children.push(child);
        },
        addEventListener: (event, handler) => {
          const handlers = element.listeners.get(event) ?? [];
          handlers.push(handler);
          element.listeners.set(event, handlers);
        },
        click: () => {
          for (const handler of element.listeners.get("click") ?? []) {
            handler();
          }
        },
        focus: () => void focused.push(element),
      };
      return element;
    };

    const attachmentList = makeElement("ul");
    // The production code clears the list with innerHTML, which a plain object
    // cannot observe, so drop the rendered rows when it is assigned.
    Object.defineProperty(attachmentList, "innerHTML", {
      get: () => "",
      set: () => {
        attachmentList.children.length = 0;
      },
    });
    const attachmentEmpty = makeElement("p");
    const attachmentStatus = makeElement("p");
    const addAttachmentBtn = makeElement("button");

    const documentStub = { createElement: makeElement };
    const posted: Array<Record<string, unknown>> = [];
    const formErrors: string[] = [];
    const webviewStrings = {
      actionOpenAttachment: "Open attachment",
      actionRemoveAttachment: "Remove attachment",
      attachmentAdded: "Attachment added",
      attachmentRemoved: "Attachment removed",
      attachmentLimitExceeded: "Too many attachments",
    };

    const snippet = [
      extractFunctionSource(source, "attachmentKey"),
      extractFunctionSource(source, "getAttachmentFileName"),
      extractFunctionSource(source, "announceAttachmentStatus"),
      extractFunctionSource(source, "renderAttachments"),
      extractFunctionSource(source, "setAttachments"),
      extractFunctionSource(source, "addAttachments"),
      "return { setAttachments: setAttachments, addAttachments: addAttachments, getState: function () { return attachmentsState; } };",
    ].join("\n");

    const factory = new Function(
      "document",
      "attachmentList",
      "attachmentEmpty",
      "attachmentStatus",
      "addAttachmentBtn",
      "attachmentsState",
      "maxAttachments",
      "strings",
      "vscode",
      "showFormError",
      "getCurrentScopeValue",
      "editingTaskId",
      snippet,
    ) as (...args: unknown[]) => {
      setAttachments(list: unknown): void;
      addAttachments(list: unknown): void;
      getState(): Array<{ source: string; path: string }>;
    };

    const api = factory(
      documentStub,
      attachmentList,
      attachmentEmpty,
      attachmentStatus,
      addAttachmentBtn,
      [],
      3,
      webviewStrings,
      {
        postMessage: (message: Record<string, unknown>) =>
          void posted.push(message),
      },
      (message: string) => void formErrors.push(message),
      () => "workspace",
      "task-1",
    );

    api.setAttachments([
      { source: "local", path: ".github/instructions/a.instructions.md" },
      { source: "local", path: ".github/instructions/a.instructions.md" },
      { source: "global", path: "prompts/b.prompt.md" },
    ]);

    assert.strictEqual(
      attachmentList.children.length,
      2,
      "duplicate attachments must collapse into a single chip",
    );
    assert.strictEqual(attachmentEmpty.style.display, "none");

    const firstChip = attachmentList.children[0];
    const openBtn = firstChip.children[0];
    assert.strictEqual(
      openBtn.attrs.get("aria-label"),
      "Open attachment: a.instructions.md",
    );
    assert.strictEqual(openBtn.children[0].textContent, "a.instructions.md");
    assert.strictEqual(
      openBtn.children[1].textContent,
      ".github/instructions/a.instructions.md",
      "the chip must show the full relative path next to the file name",
    );

    openBtn.click();
    assert.deepStrictEqual(posted, [
      {
        type: "openAttachment",
        attachment: {
          source: "local",
          path: ".github/instructions/a.instructions.md",
        },
        scope: "workspace",
        taskId: "task-1",
      },
    ]);

    const removeBtn = firstChip.children[1];
    assert.strictEqual(
      removeBtn.attrs.get("aria-label"),
      "Remove attachment: a.instructions.md",
    );
    removeBtn.click();

    assert.deepStrictEqual(
      api.getState().map((item) => item.path),
      ["prompts/b.prompt.md"],
      "removing a chip must drop that entry, not the last one",
    );
    assert.strictEqual(attachmentList.children.length, 1);
    assert.strictEqual(
      attachmentStatus.textContent,
      "Attachment removed: a.instructions.md",
    );
    assert.strictEqual(
      focused[focused.length - 1],
      addAttachmentBtn,
      "focus must land on the add button after a chip is removed",
    );

    api.addAttachments([
      { source: "local", path: "docs/c.md" },
      { source: "global", path: "prompts/b.prompt.md" },
    ]);
    assert.strictEqual(
      api.getState().length,
      2,
      "an already attached file must not be added twice",
    );
    assert.strictEqual(attachmentStatus.textContent, "Attachment added (1)");

    api.addAttachments([
      { source: "local", path: "docs/d.md" },
      { source: "local", path: "docs/e.md" },
    ]);
    assert.strictEqual(
      api.getState().length,
      3,
      "the attachment limit must cap the list",
    );
    assert.deepStrictEqual(formErrors, ["Too many attachments"]);

    api.setAttachments([]);
    assert.strictEqual(attachmentList.children.length, 0);
    assert.strictEqual(
      attachmentEmpty.style.display,
      "block",
      "the empty hint must reappear once the last chip is removed",
    );
  });
});

suite("SchedulerWebview Friendly Cron Builder Tests", () => {
  test("strict interval builder keeps exact single-cron intervals", () => {
    const build = loadWebviewStrictIntervalCronFunction();

    assert.strictEqual(build(20), "*/20 * * * *");
    assert.strictEqual(build(60), "0 * * * *");
    assert.strictEqual(build(120), "0 */2 * * *");
    assert.strictEqual(build(180), "0 */3 * * *");
  });

  test("strict interval builder expands exact multi-line intervals", () => {
    const build = loadWebviewStrictIntervalCronFunction();

    assert.strictEqual(
      build(40),
      [
        "0,40 0,2,4,6,8,10,12,14,16,18,20,22 * * *",
        "20 1,3,5,7,9,11,13,15,17,19,21,23 * * *",
      ].join("\n"),
    );
    assert.strictEqual(
      build(90),
      ["0 0,3,6,9,12,15,18,21 * * *", "30 1,4,7,10,13,16,19,22 * * *"].join(
        "\n",
      ),
    );
  });

  test("strict interval builder rejects inexact standard-cron intervals", () => {
    const build = loadWebviewStrictIntervalCronFunction();

    assert.strictEqual(build(7), "");
    assert.strictEqual(build(25), "");
    assert.strictEqual(build(50), "");
  });

  test("friendly cron expression builder maps selections to cron", () => {
    const build = loadWebviewFriendlyCronExpressionFunction();

    assert.strictEqual(
      build({ selection: "every-n", interval: 20 }),
      "*/20 * * * *",
    );
    assert.strictEqual(
      build({ selection: "hourly", minute: 15 }),
      "15 * * * *",
    );
    assert.strictEqual(
      build({ selection: "daily", hour: 9, minute: 30 }),
      "30 9 * * *",
    );
    assert.strictEqual(
      build({ selection: "weekly", dow: 1, hour: 10, minute: 5 }),
      "5 10 * * 1",
    );
    assert.strictEqual(
      build({ selection: "monthly", dom: 3, hour: 8, minute: 45 }),
      "45 8 3 * *",
    );
  });

  test("friendly cron expression builder preserves cron on unsupported selections", () => {
    const build = loadWebviewFriendlyCronExpressionFunction();

    assert.strictEqual(build({ selection: "" }), null);
    assert.strictEqual(build({ selection: "every-n", interval: 7 }), null);
    assert.strictEqual(
      build({ selection: "every-n", interval: "" }),
      "*/20 * * * *",
    );
  });

  test("friendly cron form uses select controls for bounded fields", () => {
    const webviewSourcePath = path.resolve(
      __dirname,
      "../../../src/schedulerWebview.ts",
    );
    const source = fs.readFileSync(webviewSourcePath, "utf8");

    assert.ok(
      sourceContainsToken(source, '<select id="friendly-interval">'),
      "friendly interval should be a select.",
    );
    assert.ok(
      sourceContainsToken(source, '<select id="friendly-minute">'),
      "friendly minute should be a select.",
    );
    assert.ok(
      sourceContainsToken(source, '<select id="friendly-hour">'),
      "friendly hour should be a select.",
    );
    assert.ok(
      sourceContainsToken(source, "Array.from({ length: 28 }"),
      "monthly day options should default to days 1-28.",
    );
    assert.ok(
      sourceContainsToken(
        source,
        "friendlyIntervalMinutes: FRIENDLY_INTERVAL_MINUTES",
      ),
      "friendly interval options should be passed through initial data.",
    );
  });

  test("crontab.guru button is disabled for multi-line expressions", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    assert.ok(
      sourceContainsToken(source, "splitCronLines(expression).length > 1"),
      "crontab.guru click handler should reject multi-line cron expressions.",
    );
    assert.ok(
      sourceContainsToken(source, "openGuruBtn.disabled = hasMultipleLines"),
      "preview update should disable crontab.guru for multi-line cron expressions.",
    );
  });

  test("friendly cron controls auto-apply without requiring generate", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    assert.ok(
      sourceContainsToken(source, "applyFriendlyCronSelection(true)"),
      "generate button should use the shared friendly cron apply helper.",
    );
    assertTokensInOrder(
      source,
      [
        'friendlyFrequency.addEventListener("change", function (e)',
        "syncFriendlyFrequencySelection();",
        "e.__friendlyFrequencyHandled = true;",
      ],
      "friendly frequency direct handler should auto-apply once and mark the event handled",
    );
    assertTokensInOrder(
      source,
      [
        'target.id === "friendly-frequency"',
        "if (!e.__friendlyFrequencyHandled)",
        "syncFriendlyFrequencySelection();",
      ],
      "delegated frequency fallback should skip events already handled directly",
    );
    assert.ok(
      sourceContainsToken(source, 'target.id === "friendly-frequency"'),
      "delegated frequency fallback should still recognize friendly-frequency.",
    );
    assert.ok(
      sourceContainsToken(source, '"friendly-interval"'),
      "friendly interval changes should auto-apply.",
    );
    assert.ok(
      sourceContainsToken(source, '"friendly-minute"'),
      "friendly minute changes should auto-apply.",
    );
    assert.ok(
      sourceContainsToken(source, '"friendly-hour"'),
      "friendly hour changes should auto-apply.",
    );
    assert.ok(
      sourceContainsToken(source, '"friendly-dow"'),
      "friendly day-of-week changes should auto-apply.",
    );
    assert.ok(
      sourceContainsToken(source, '"friendly-dom"'),
      "friendly day-of-month changes should auto-apply.",
    );
  });

  test("edit mode clears friendly cron selection before loading task cron", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    assertTokensInOrder(
      source,
      [
        "window.editTask = function (id)",
        'if (cronExpression) cronExpression.value = task.cronExpression || "";',
        'if (cronPreset) cronPreset.value = "";',
        'if (friendlyFrequency) friendlyFrequency.value = "";',
        "updateFriendlyVisibility();",
        "updateCronPreview();",
      ],
      "edit mode should clear stale friendly cron selection before showing task cron",
    );
  });

  test("webview cron preview stays aligned with extension display formatter", async () => {
    const { formatCronForDisplay } = await import("../../i18n");
    const summarizeInWebview = loadWebviewCronSummaryFunction();
    const expressions = [
      "*/20 * * * *",
      "0 * * * *",
      "0 */2 * * *",
      "0 9 * * *",
      "0 9 * * 1-5",
      "0 9 * * 1",
      "0 9 1 * *",
      ["0 0,3,6,9,12,15,18,21 * * *", "30 1,4,7,10,13,16,19,22 * * *"].join(
        "\n",
      ),
      "0 0,3 * * *\n30 1,4 * * *",
    ];

    for (const expression of expressions) {
      assert.strictEqual(
        summarizeInWebview(expression),
        formatCronForDisplay(expression),
      );
    }
  });
});

suite("SchedulerWebview Message Queue Tests", () => {
  test("Queues messages until ready and flushes (dedup by type)", () => {
    const wv = SchedulerWebview as unknown as {
      panel?: WebviewPanelLike;
      webviewReady?: boolean;
      pendingMessages?: unknown[];
      postMessage?: (message: unknown) => void;
      flushPendingMessages?: () => void;
    };

    const originalPanel = wv.panel;
    const originalReady = wv.webviewReady;
    const originalPending = wv.pendingMessages;

    const sent: unknown[] = [];

    try {
      wv.panel = {
        webview: {
          postMessage: (message: unknown) => {
            sent.push(message);
            return Promise.resolve(true);
          },
        },
      };

      wv.webviewReady = false;
      wv.pendingMessages = [];

      assert.ok(typeof wv.postMessage === "function");
      assert.ok(typeof wv.flushPendingMessages === "function");

      wv.postMessage({ type: "updateTasks", tasks: [1] });
      wv.postMessage({ type: "updateTasks", tasks: [2] });
      wv.postMessage({ type: "updateAgents", agents: ["a"] });

      const queued = wv.pendingMessages as Array<{
        type?: unknown;
        [k: string]: unknown;
      }>;
      assert.strictEqual(queued.length, 2);

      const updateTasks = queued.find((m) => m.type === "updateTasks") as
        | { tasks?: unknown }
        | undefined;
      assert.ok(updateTasks);
      assert.deepStrictEqual(updateTasks?.tasks, [2]);

      wv.webviewReady = true;
      wv.flushPendingMessages();

      assert.strictEqual(sent.length, 2);

      const sentMessages = sent as Array<{
        type?: unknown;
        [k: string]: unknown;
      }>;
      const sentUpdateTasks = sentMessages.find(
        (m) => m.type === "updateTasks",
      ) as { tasks?: unknown } | undefined;
      assert.ok(sentUpdateTasks);
      assert.deepStrictEqual(sentUpdateTasks?.tasks, [2]);

      const sentUpdateAgents = sentMessages.find(
        (m) => m.type === "updateAgents",
      ) as { agents?: unknown } | undefined;
      assert.ok(sentUpdateAgents);
      assert.deepStrictEqual(sentUpdateAgents?.agents, ["a"]);

      assert.strictEqual((wv.pendingMessages ?? []).length, 0);
    } finally {
      wv.panel = originalPanel;
      wv.webviewReady = originalReady;
      wv.pendingMessages = originalPending;
    }
  });

  test("updateTasks message includes workspacePaths and schedule summaries", () => {
    const wv = SchedulerWebview as unknown as {
      panel?: WebviewPanelLike;
      webviewReady?: boolean;
      pendingMessages?: unknown[];
      currentTasks?: unknown[];
      updateTasks?: (tasks: ScheduledTask[]) => void;
    };

    const originalPanel = wv.panel;
    const originalReady = wv.webviewReady;
    const originalPending = wv.pendingMessages;
    const originalTasks = wv.currentTasks;

    const sent: unknown[] = [];

    try {
      wv.panel = {
        webview: {
          postMessage: (message: unknown) => {
            sent.push(message);
            return Promise.resolve(true);
          },
        },
      };
      wv.webviewReady = true;
      wv.pendingMessages = [];

      assert.ok(typeof SchedulerWebview.updateTasks === "function");
      SchedulerWebview.updateTasks([
        {
          id: "task-webview-summary",
          name: "Summary task",
          cronExpression: "*/20 * * * *",
          prompt: "hello",
          enabled: true,
          scope: "workspace",
          promptSource: "inline",
          createdAt: new Date("2026-05-15T00:00:00Z"),
          updatedAt: new Date("2026-05-15T00:00:00Z"),
        },
      ]);

      assert.strictEqual(sent.length, 1);
      const m = sent[0] as {
        type?: unknown;
        workspacePaths?: unknown;
        tasks?: Array<{ scheduleSummary?: unknown }>;
      };
      assert.strictEqual(m.type, "updateTasks");
      assert.ok(
        Array.isArray(m.workspacePaths),
        "updateTasks message must carry workspacePaths array",
      );
      assert.strictEqual(
        m.tasks?.[0]?.scheduleSummary,
        messages.cronPreviewEveryNMinutes().replace("{n}", "20"),
      );
    } finally {
      wv.panel = originalPanel;
      wv.webviewReady = originalReady;
      wv.pendingMessages = originalPending;
      wv.currentTasks = originalTasks;
    }
  });

  test("updatePromptPreviews keeps the newest resolution per task", () => {
    const wv = SchedulerWebview as unknown as {
      panel?: WebviewPanelLike;
      webviewReady?: boolean;
      pendingMessages?: unknown[];
      promptPreviews?: Map<string, PromptPreview>;
      currentTasks?: ScheduledTask[];
    };
    const originalPanel = wv.panel;
    const originalReady = wv.webviewReady;
    const originalPending = wv.pendingMessages;
    const originalPreviews = wv.promptPreviews;
    const originalTasks = wv.currentTasks;

    try {
      wv.panel = {
        webview: { postMessage: () => Promise.resolve(true) },
      };
      wv.webviewReady = true;
      wv.pendingMessages = [];
      wv.promptPreviews = new Map<string, PromptPreview>();

      const base: PromptPreview = {
        taskId: "preview-task",
        promptPath: ".github/prompts/daily.md",
        promptPathDisplay: "daily.md",
        source: "file",
        hash: "new-hash",
        resolvedAt: "2026-07-30T10:00:00.000Z",
        canOpenPromptFile: true,
        hasSnapshotDiff: true,
        prompt: "new",
      };
      SchedulerWebview.updatePromptPreviews([base]);
      SchedulerWebview.updatePromptPreviews([
        {
          ...base,
          hash: "old-hash",
          prompt: "old",
          resolvedAt: "2026-07-30T09:00:00.000Z",
        },
      ]);

      assert.strictEqual(wv.promptPreviews.get("preview-task")?.prompt, "new");

      SchedulerWebview.updateTasks([
        {
          id: "preview-task",
          name: "Preview task",
          cronExpression: "0 * * * *",
          prompt: "snapshot",
          enabled: true,
          scope: "workspace",
          promptSource: "local",
          promptPath: ".github/prompts/other.md",
          createdAt: new Date("2026-07-30T00:00:00.000Z"),
          updatedAt: new Date("2026-07-30T00:00:00.000Z"),
        },
      ]);
      assert.strictEqual(wv.promptPreviews.has("preview-task"), false);
    } finally {
      wv.panel = originalPanel;
      wv.webviewReady = originalReady;
      wv.pendingMessages = originalPending;
      wv.promptPreviews = originalPreviews;
      wv.currentTasks = originalTasks;
    }
  });
});

suite("SchedulerWebview Test Prompt Routing Tests", () => {
  test("handleMessage forwards testPrompt to callback", async () => {
    const wv = SchedulerWebview as unknown as {
      onTestPromptCallback?: (request: {
        prompt: string;
        agent?: string;
        model?: string;
        modelVendor?: string;
        modelFamily?: string;
        modelVersion?: string;
      }) => void;
      handleMessage?: (message: unknown) => Promise<void>;
    };

    const originalCallback = wv.onTestPromptCallback;
    let received:
      | {
          prompt: string;
          agent?: string;
          model?: string;
        }
      | undefined;

    try {
      wv.onTestPromptCallback = (request) => {
        received = {
          prompt: request.prompt,
          agent: request.agent,
          model: request.model,
        };
      };

      assert.ok(typeof wv.handleMessage === "function");

      await wv.handleMessage?.({
        type: "testPrompt",
        prompt: "hello",
        agent: "@workspace",
        model: "gpt-4o",
        modelVendor: "copilot",
        modelFamily: "gpt-4o",
        modelVersion: "2026-01-01",
      });

      assert.deepStrictEqual(received, {
        prompt: "hello",
        agent: "@workspace",
        model: "gpt-4o",
      });
    } finally {
      wv.onTestPromptCallback = originalCallback;
    }
  });

  test("handleMessage forwards prompt preview and open-file requests by task id", async () => {
    const wv = SchedulerWebview as unknown as {
      onPromptPreviewRequestCallback?: (taskId: string) => void;
      onOpenPromptFileCallback?: (taskId: string) => void;
      handleMessage?: (message: unknown) => Promise<void>;
    };
    const originalPreview = wv.onPromptPreviewRequestCallback;
    const originalOpen = wv.onOpenPromptFileCallback;
    const calls: string[] = [];

    try {
      wv.onPromptPreviewRequestCallback = (taskId) =>
        calls.push(`preview:${taskId}`);
      wv.onOpenPromptFileCallback = (taskId) => calls.push(`open:${taskId}`);

      await wv.handleMessage?.({
        type: "requestPromptPreview",
        taskId: "task-a",
      });
      await wv.handleMessage?.({ type: "openPromptFile", taskId: "task-a" });

      assert.deepStrictEqual(calls, ["preview:task-a", "open:task-a"]);
    } finally {
      wv.onPromptPreviewRequestCallback = originalPreview;
      wv.onOpenPromptFileCallback = originalOpen;
    }
  });

  test("webviewReady requests previews only for file-backed tasks", async () => {
    const wv = SchedulerWebview as unknown as {
      currentTasks?: ScheduledTask[];
      webviewReady?: boolean;
      pendingMessages?: unknown[];
      onPromptPreviewRequestCallback?: (taskId: string) => void;
      handleMessage?: (message: unknown) => Promise<void>;
    };
    const originalTasks = wv.currentTasks;
    const originalReady = wv.webviewReady;
    const originalPending = wv.pendingMessages;
    const originalPreview = wv.onPromptPreviewRequestCallback;
    const requested: string[] = [];

    try {
      wv.currentTasks = [
        {
          id: "local-task",
          name: "Local",
          cronExpression: "0 * * * *",
          prompt: "snapshot",
          enabled: true,
          scope: "workspace",
          promptSource: "local",
          promptPath: ".github/prompts/local.md",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "inline-task",
          name: "Inline",
          cronExpression: "0 * * * *",
          prompt: "inline",
          enabled: true,
          scope: "workspace",
          promptSource: "inline",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      wv.webviewReady = false;
      wv.pendingMessages = [];
      wv.onPromptPreviewRequestCallback = (taskId) => requested.push(taskId);

      await wv.handleMessage?.({ type: "webviewReady" });

      assert.strictEqual(wv.webviewReady, true);
      assert.deepStrictEqual(requested, ["local-task"]);
    } finally {
      wv.currentTasks = originalTasks;
      wv.webviewReady = originalReady;
      wv.pendingMessages = originalPending;
      wv.onPromptPreviewRequestCallback = originalPreview;
    }
  });

  test("webview script includes test button -> testPrompt postMessage flow", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const testButtonClickStart = source.indexOf(
      'testBtn.addEventListener("click"',
    );
    assert.ok(
      testButtonClickStart >= 0,
      "test button click handler was not found.",
    );

    const testButtonBlockStart = source.lastIndexOf(
      "if (testBtn)",
      testButtonClickStart,
    );
    assert.ok(
      testButtonBlockStart >= 0,
      "test button guard block was not found.",
    );

    const testButtonBlockEnd = source.indexOf(
      "if (refreshBtn)",
      testButtonBlockStart,
    );
    assert.ok(
      testButtonBlockEnd > testButtonBlockStart,
      "test button block end anchor was not found. Check refresh button guard in media/schedulerWebview.js",
    );

    const block = source.slice(testButtonBlockStart, testButtonBlockEnd);
    assert.ok(
      sourceContainsToken(block, 'type: "testPrompt"'),
      "test button does not post testPrompt message.",
    );
    assert.ok(
      sourceContainsToken(
        block,
        'showFormError(strings.promptRequired || "", 5000)',
      ),
      "empty prompt should show promptRequired error in test button flow.",
    );
  });

  test("template loading helpers also toggle test button disabled state", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const setStart = source.indexOf("function setTemplateLoading(pathValue)");
    const clearStart = source.indexOf(
      "function clearTemplateLoading(pathValue)",
    );
    assert.ok(setStart >= 0, "setTemplateLoading was not found.");
    assert.ok(clearStart > setStart, "clearTemplateLoading was not found.");

    const setBlock = source.slice(setStart, clearStart);
    assert.ok(
      sourceContainsToken(setBlock, "if (testBtn)"),
      "setTemplateLoading should handle testBtn disabled state.",
    );
    assert.ok(
      sourceContainsToken(setBlock, "testBtn.disabled = !!templateLoadingPath"),
      "setTemplateLoading should disable testBtn while loading.",
    );

    // Note: "source" in the search string below is a parameter name in the
    // JS function, not the outer `source` variable (file contents).
    const requestStart = source.indexOf(
      "function requestTemplateLoad(selectedPath, source)",
      clearStart,
    );
    assert.ok(
      requestStart > clearStart,
      "requestTemplateLoad anchor was not found.",
    );
    const clearBlock = source.slice(clearStart, requestStart);
    assert.ok(
      sourceContainsToken(clearBlock, "if (testBtn)"),
      "clearTemplateLoading should handle testBtn disabled state.",
    );
    assert.ok(
      sourceContainsToken(clearBlock, "testBtn.disabled = false"),
      "clearTemplateLoading should re-enable testBtn.",
    );
  });
});

suite("SchedulerWebview Script Contract Tests", () => {
  test("Edit form delete button is wired with delete-availability guard", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const expectedTokens = [
      'var editDeleteBtn = document.getElementById("edit-delete-btn")',
      "var editingTaskCanDelete = false",
      "editingTaskCanDelete =",
      "setEditingMode(id, { canDelete: canDeleteInEdit });",
      "if (!editingTaskId || !editingTaskCanDelete)",
      "window.deleteTask(editingTaskId)",
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(source, token),
        `Expected token not found for edit delete wiring: ${token}`,
      );
    }
  });

  test("updateTasks message refreshes workspacePaths and edit delete state", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const updateTasksStart = source.indexOf('case "updateTasks":');
    assert.ok(updateTasksStart >= 0, "updateTasks case was not found.");

    const updateAgentsStart = source.indexOf(
      'case "updateAgents":',
      updateTasksStart,
    );
    assert.ok(
      updateAgentsStart > updateTasksStart,
      "updateTasks case end anchor was not found.",
    );

    const updateTasksSource = source.slice(updateTasksStart, updateAgentsStart);

    const expectedTokens = [
      "if (Array.isArray(message.workspacePaths))",
      "workspacePaths = message.workspacePaths.filter(Boolean);",
      "if (editingTaskId)",
      "setEditingMode(null);",
      "setEditingMode(editingTaskId, { canDelete: canDeleteInEdit });",
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(updateTasksSource, token),
        `Expected token not found in updateTasks flow: ${token}`,
      );
    }
  });

  test("refreshFormDefaults posts bounded defaults to the webview", () => {
    const wv = SchedulerWebview as unknown as {
      panel?: WebviewPanelLike;
      webviewReady?: boolean;
      pendingMessages?: unknown[];
      refreshFormDefaults?: () => void;
    };
    const originalPanel = wv.panel;
    const originalReady = wv.webviewReady;
    const originalPending = wv.pendingMessages;
    const originalGetConfiguration = vscode.workspace.getConfiguration;
    const sent: unknown[] = [];

    try {
      wv.panel = {
        webview: {
          postMessage: (message: unknown) => {
            sent.push(message);
            return Promise.resolve(true);
          },
        },
      };
      wv.webviewReady = true;
      wv.pendingMessages = [];

      (
        vscode.workspace as typeof vscode.workspace & {
          getConfiguration: typeof vscode.workspace.getConfiguration;
        }
      ).getConfiguration = (() => {
        return {
          get<T>(section: string, defaultValue?: T): T {
            if (section === "defaultScope") {
              return "global" as T;
            }
            if (section === "autoModeDefault") {
              return true as T;
            }
            if (section === "chatSession") {
              return "new" as T;
            }
            if (section === "jitterSeconds") {
              return 9999 as T;
            }
            return defaultValue as T;
          },
        } as vscode.WorkspaceConfiguration;
      }) as typeof vscode.workspace.getConfiguration;

      assert.ok(typeof wv.refreshFormDefaults === "function");
      wv.refreshFormDefaults();

      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0], {
        type: "updateDefaults",
        defaultScope: "global",
        defaultAutoMode: true,
        defaultChatSession: "new",
        defaultChatSessionNote: messages.webviewChatSessionNote(
          messages.labelChatSessionNew(),
        ),
        defaultJitterSeconds: 1800,
      });
    } finally {
      (
        vscode.workspace as typeof vscode.workspace & {
          getConfiguration: typeof vscode.workspace.getConfiguration;
        }
      ).getConfiguration = originalGetConfiguration;
      wv.panel = originalPanel;
      wv.webviewReady = originalReady;
      wv.pendingMessages = originalPending;
    }
  });

  test("updateDefaults applies new defaults immediately only in create mode", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const applyDefaultsSource = extractBlockFromStartToken(
      source,
      "function applyUpdatedDefaultsToCreateForm() {",
    );

    const applyDefaultsTokens = [
      "updateChatSessionDefaultNote();",
      "if (editingTaskId)",
      "return;",
      "if (autoModeInput) autoModeInput.checked = defaultAutoMode;",
      "jitterSecondsInput.value = String(defaultJitterSeconds);",
      'input[name="scope"][value="\' + defaultScope + \'"]',
      "defaultScopeInput.checked = true;",
    ];

    for (const token of applyDefaultsTokens) {
      assert.ok(
        sourceContainsToken(applyDefaultsSource, token),
        `Expected token not found in applyUpdatedDefaultsToCreateForm: ${token}`,
      );
    }

    const updateDefaultsStart = source.indexOf('case "updateDefaults":');
    assert.ok(updateDefaultsStart >= 0, "updateDefaults case was not found.");

    const promptTemplateLoadedStart = source.indexOf(
      'case "promptTemplateLoaded":',
      updateDefaultsStart,
    );
    assert.ok(
      promptTemplateLoadedStart > updateDefaultsStart,
      "updateDefaults case end anchor was not found.",
    );

    const updateDefaultsSource = source.slice(
      updateDefaultsStart,
      promptTemplateLoadedStart,
    );
    assert.ok(
      sourceContainsToken(
        updateDefaultsSource,
        "applyUpdatedDefaultsToCreateForm();",
      ),
      "updateDefaults should apply defaults to the create form immediately.",
    );
  });

  test("resetForm reapplies settings-backed default scope", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const resetSource = extractBlockFromStartToken(
      source,
      "function resetForm() {",
    );

    const expectedTokens = [
      "document.querySelector(",
      'input[name="scope"][value="\' + defaultScope + \'"]',
      "defaultScopeInput.checked = true;",
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(resetSource, token),
        `Expected token not found in resetForm default-scope flow: ${token}`,
      );
    }
  });

  test("guardrail number inputs use integer steps in the initial HTML", async () => {
    const panel = {
      webview: {
        html: "",
        cspSource: "vscode-webview://test",
        asWebviewUri: (uri: vscode.Uri) => uri,
        postMessage: async () => true,
        onDidReceiveMessage: () => ({ dispose() {} }),
      },
      reveal: () => undefined,
      dispose: () => undefined,
      onDidDispose: () => ({ dispose() {} }),
    } as unknown as vscode.WebviewPanel;
    const originalCreateWebviewPanel = vscode.window.createWebviewPanel;

    Object.defineProperty(vscode.window, "createWebviewPanel", {
      value: (() => panel) as typeof vscode.window.createWebviewPanel,
      configurable: true,
    });
    try {
      await SchedulerWebview.show(
        vscode.Uri.file(path.resolve(__dirname, "../../..")),
        [],
        () => {},
      );

      const html = panel.webview.html;
      assert.match(
        html,
        /id="jitter-seconds"[^>]*step="1"/,
        "jitter seconds input should use integer steps",
      );
      assert.match(
        html,
        /id="max-executions-per-day"[^>]*step="1"/,
        "max executions per day input should use integer steps",
      );
    } finally {
      SchedulerWebview.dispose();
      Object.defineProperty(vscode.window, "createWebviewPanel", {
        value: originalCreateWebviewPanel,
        configurable: true,
      });
    }
  });

  test("form submission normalizes guardrail number inputs to bounded integers", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const submitSource = extractBlockFromStartToken(source, "if (taskForm) {");

    const expectedTokens = [
      'chatSession: chatSessionSelect ? chatSessionSelect.value : "default"',
      "jitterSeconds: jitterSecondsInput",
      "? boundedNumber(jitterSecondsInput.value || 0, 0, 1800, 0)",
      "maxExecutionsPerDay: maxExecutionsPerDayInput",
      "? boundedNumber(maxExecutionsPerDayInput.value || 0, 0, 100, 0)",
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(submitSource, token),
        `Expected token not found in submit normalization flow: ${token}`,
      );
    }
  });

  test("submit converts edited template prompt to inline source", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const submitSource = extractBlockFromStartToken(
      source,
      'taskForm.addEventListener("submit", function (e) {',
    );

    const expectedTokens = [
      "templatePromptBaseline === null",
      "templatePromptBaseline !== null",
      "taskData.prompt !== templatePromptBaseline",
      "strings.promptFileNotLoadedNote",
      'taskData.promptSource = "inline"',
      'taskData.promptPath = ""',
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(submitSource, token),
        `Expected token not found in submit inline-convert flow: ${token}`,
      );
    }
  });

  test("prompt file notice mirrors template save states", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const noticeSource = extractBlockFromStartToken(
      source,
      "function updatePromptFileNotice() {",
    );

    const expectedTokens = [
      'source === "inline"',
      "loadingCurrentTemplate",
      "templatePromptBaseline === null",
      'String(promptText.value || "") === templatePromptBaseline',
      "strings.promptFileExecutionNote",
      "strings.promptFileWillBecomeInline",
      "strings.promptFileNotLoadedNote",
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(noticeSource, token),
        `Expected token not found in prompt file notice flow: ${token}`,
      );
    }
  });

  test("prompt file metadata reports path, resolution time, diff, and stale state", () => {
    const scriptSource = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );
    const metaSource = extractBlockFromStartToken(
      scriptSource,
      "function buildPromptFileMeta(preview) {",
    );

    for (const token of [
      "strings.labelPromptFileSource",
      "basenameFromPathLike(preview.promptPathDisplay)",
      "strings.labelPromptFileSynced",
      'preview.source !== "file"',
      "strings.promptFileStaleHint",
      "preview.hasSnapshotDiff",
      "strings.labelPromptFileDiff",
    ]) {
      assert.ok(
        sourceContainsToken(metaSource, token),
        `Expected token not found in prompt metadata flow: ${token}`,
      );
    }
  });

  test("prompt file notice keeps actions outside the live region and recovers focus", () => {
    const htmlSource = fs.readFileSync(
      path.resolve(__dirname, "../../../src/schedulerWebview.ts"),
      "utf8",
    );
    const scriptSource = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );
    const noticeStart = htmlSource.indexOf('id="prompt-file-notice"');
    const liveStart = htmlSource.indexOf(
      'id="prompt-file-notice-live" role="status" aria-live="polite" aria-atomic="true"',
      noticeStart,
    );
    const liveEnd = htmlSource.indexOf("</div>", liveStart);
    const actionsStart = htmlSource.indexOf(
      'class="prompt-file-notice-actions"',
      liveStart,
    );

    assert.ok(noticeStart >= 0 && liveStart > noticeStart);
    assert.ok(liveEnd > liveStart && actionsStart > liveEnd);
    assert.ok(
      sourceContainsToken(
        scriptSource,
        "document.activeElement === loadLatestPromptBtn",
      ),
    );
    assert.ok(
      sourceContainsToken(
        scriptSource,
        "document.activeElement === openPromptFileBtn",
      ),
    );
    assert.ok(sourceContainsToken(scriptSource, "promptTextInput.focus()"));
  });

  test("task list rendering prunes removed and path-mismatched previews", () => {
    const scriptSource = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );
    const pruneSource = extractBlockFromStartToken(
      scriptSource,
      "function prunePromptFilePreviews() {",
    );
    const renderSource = extractBlockFromStartToken(
      scriptSource,
      "function renderTaskList(nextTasks) {",
    );

    assert.ok(
      sourceContainsToken(pruneSource, "delete promptFilePreviews[taskId]"),
    );
    assert.ok(
      sourceContainsToken(pruneSource, 'String(task.promptPath || "").trim()'),
    );
    assert.ok(sourceContainsToken(renderSource, "prunePromptFilePreviews()"));
  });

  test("latest prompt action applies preview text and resets the baseline", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");
    const start = source.indexOf(
      'loadLatestPromptBtn.addEventListener("click", function () {',
    );
    const end = source.indexOf("if (openPromptFileBtn) {", start);
    assert.ok(start >= 0 && end > start, "Latest prompt handler was not found");
    const handler = source.slice(start, end);

    const expectedTokens = [
      "getActivePromptFilePreview()",
      'preview.source !== "file"',
      "window.confirm(strings.confirmReplacePromptEdits",
      "promptTextInput.value = preview.prompt",
      "setTemplatePromptBaseline(preview.prompt)",
    ];
    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(handler, token),
        `Expected token not found in latest prompt handler: ${token}`,
      );
    }
  });

  test("prompt file actions ignore previews for a non-selected template", () => {
    const scriptSource = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );
    const resolverSource = extractBlockFromStartToken(
      scriptSource,
      "function getActivePromptFilePreview() {",
    );

    for (const token of [
      "if (!editingTaskId) return null",
      "getPromptFilePreview(getTaskById(editingTaskId))",
      'selectedPath !== String(preview.promptPath || "")',
      "return null",
    ]) {
      assert.ok(
        sourceContainsToken(resolverSource, token),
        `Expected token not found in active preview resolver: ${token}`,
      );
    }

    const noticeSource = extractBlockFromStartToken(
      scriptSource,
      "function updatePromptFileNotice() {",
    );
    assert.ok(
      sourceContainsToken(noticeSource, "getActivePromptFilePreview()"),
      "Prompt file notice must resolve the preview through the selection-aware helper",
    );

    const openStart = scriptSource.indexOf(
      'openPromptFileBtn.addEventListener("click", function () {',
    );
    assert.ok(openStart >= 0, "Open prompt file handler was not found");
    const openHandler = scriptSource.slice(openStart, openStart + 600);
    assert.ok(
      sourceContainsToken(
        openHandler,
        "if (!preview || !preview.canOpenPromptFile) return",
      ),
      "Open prompt file must be blocked when the preview does not match the selection",
    );
  });

  test("prompt field is read-only for file-backed prompt sources", () => {
    const scriptSource = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );
    const noticeSource = extractBlockFromStartToken(
      scriptSource,
      "function updatePromptFileNotice() {",
    );

    const expectedTokens = [
      'var isFileBackedSource = source === "local" || source === "global"',
      "promptText.readOnly = isFileBackedSource",
      'promptText.setAttribute("aria-readonly", "true")',
      'promptText.removeAttribute("aria-readonly")',
    ];
    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(noticeSource, token),
        `Expected token not found in prompt read-only flow: ${token}`,
      );
    }
  });

  test("editing form re-syncs the prompt field from the latest file preview", () => {
    const scriptSource = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );
    const syncSource = extractBlockFromStartToken(
      scriptSource,
      "function syncEditingPromptFromPreview() {",
    );

    const expectedTokens = [
      'source !== "local" && source !== "global"',
      "if (templateLoadingPath) return",
      "getActivePromptFilePreview()",
      'preview.source !== "file"',
      "if (promptTextInput.value !== preview.prompt)",
      "promptTextInput.value = preview.prompt",
      "setTemplatePromptBaseline(preview.prompt)",
    ];
    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(syncSource, token),
        `Expected token not found in prompt preview sync flow: ${token}`,
      );
    }

    assert.ok(
      !sourceContainsToken(
        syncSource,
        "if (promptTextInput.value === preview.prompt) return",
      ),
      "Baseline must be re-anchored even when the textarea already matches the file",
    );

    assert.ok(
      sourceContainsToken(scriptSource, "syncEditingPromptFromPreview();"),
      "syncEditingPromptFromPreview is never called",
    );
  });

  test("tabs, feedback banners, and cron controls expose ARIA semantics", () => {
    const htmlSource = fs.readFileSync(
      path.resolve(__dirname, "../../../src/schedulerWebview.ts"),
      "utf8",
    );

    for (const token of [
      '<div class="tabs" role="tablist">',
      'id="create-tab-button"',
      'role="tab" aria-selected="true" aria-controls="create-tab"',
      'id="list-tab-button"',
      'role="tab" aria-selected="false" aria-controls="list-tab"',
      'id="create-tab" class="tab-content active" role="tabpanel" aria-labelledby="create-tab-button"',
      'id="list-tab" class="tab-content" role="tabpanel" aria-labelledby="list-tab-button"',
      'id="form-error" class="feedback-banner feedback-banner-error" role="alert"',
      'id="success-toast" class="feedback-banner feedback-banner-success" role="status" aria-live="polite"',
      '<label for="cron-preset">',
      '<label for="cron-expression">',
    ]) {
      assert.ok(
        sourceContainsToken(htmlSource, token),
        `Expected accessibility token not found in webview HTML: ${token}`,
      );
    }
  });

  test("switchTab syncs aria-selected and rescues focus from the hidden panel", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );

    type StubElement = {
      children: StubElement[];
      classList: { add(name: string): void; remove(name: string): void };
      setAttribute(name: string, value: string): void;
      getAttribute(name: string): string | null;
      contains(node: unknown): boolean;
      focus(): void;
      hasClass(name: string): boolean;
    };

    const state: { activeElement: StubElement | null } = {
      activeElement: null,
    };

    const makeElement = (className = ""): StubElement => {
      const classes = new Set(className.split(" ").filter(Boolean));
      const attrs = new Map<string, string>();
      const children: StubElement[] = [];
      const element: StubElement = {
        children,
        classList: {
          add: (name: string) => void classes.add(name),
          remove: (name: string) => void classes.delete(name),
        },
        setAttribute: (name: string, value: string) =>
          void attrs.set(name, value),
        getAttribute: (name: string) => attrs.get(name) ?? null,
        contains: (node: unknown) =>
          node === element || children.indexOf(node as StubElement) >= 0,
        focus: () => {
          state.activeElement = element;
        },
        hasClass: (name: string) => classes.has(name),
      };
      return element;
    };

    const createBtn = makeElement("tab-button active");
    const listBtn = makeElement("tab-button");
    const createPanel = makeElement("tab-content active");
    const listPanel = makeElement("tab-content");
    const submitBtn = makeElement();
    createPanel.children.push(submitBtn);

    const documentStub = {
      get activeElement() {
        return state.activeElement;
      },
      querySelector(selector: string) {
        if (selector === '.tab-button[data-tab="create"]') return createBtn;
        if (selector === '.tab-button[data-tab="list"]') return listBtn;
        return null;
      },
      querySelectorAll(selector: string) {
        if (selector === ".tab-button") return [createBtn, listBtn];
        if (selector === ".tab-content") return [createPanel, listPanel];
        return [];
      },
      getElementById(id: string) {
        if (id === "create-tab") return createPanel;
        if (id === "list-tab") return listPanel;
        return null;
      },
    };

    const factory = new Function(
      "document",
      "scheduleLayoutRefresh",
      [extractFunctionSource(source, "switchTab"), "return switchTab;"].join(
        "\n",
      ),
    ) as (
      doc: typeof documentStub,
      refresh: () => void,
    ) => (tabName: string) => void;
    const switchTab = factory(documentStub, () => undefined);

    submitBtn.focus();
    switchTab("list");

    assert.strictEqual(
      state.activeElement,
      listBtn,
      "Focus must move to the target tab button when the focused panel is hidden",
    );
    assert.strictEqual(createBtn.getAttribute("aria-selected"), "false");
    assert.strictEqual(listBtn.getAttribute("aria-selected"), "true");
    assert.strictEqual(createPanel.hasClass("active"), false);
    assert.strictEqual(listPanel.hasClass("active"), true);

    state.activeElement = null;
    switchTab("create");

    assert.strictEqual(
      state.activeElement,
      null,
      "switchTab must not steal focus when nothing inside a hidden panel was focused",
    );
    assert.strictEqual(createBtn.getAttribute("aria-selected"), "true");
    assert.strictEqual(listBtn.getAttribute("aria-selected"), "false");
  });

  test("submit validation focuses and marks the offending field", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );
    const failValidationSource = extractFunctionSource(
      source,
      "failValidation",
    );

    for (const token of [
      "clearInvalidField()",
      "showFormError(message)",
      'fieldElement.setAttribute("aria-invalid", "true")',
      'fieldElement.setAttribute("aria-describedby", "form-error")',
      "fieldElement.focus()",
    ]) {
      assert.ok(
        sourceContainsToken(failValidationSource, token),
        `Expected token not found in failValidation: ${token}`,
      );
    }

    const submitSource = extractBlockFromStartToken(
      source,
      'taskForm.addEventListener("submit", function (e) {',
    );
    for (const token of [
      "failValidation(strings.taskNameRequired",
      "failValidation(strings.templateRequired",
      "failValidation(strings.promptRequired",
      "cronExpression,",
      "allowedTimeStartInput,",
      "allowedTimeEndInput,",
      "clearInvalidField();",
    ]) {
      assert.ok(
        sourceContainsToken(submitSource, token),
        `Expected token not found in submit validation flow: ${token}`,
      );
    }

    assert.ok(
      !sourceContainsToken(
        submitSource,
        "formErr.textContent = strings.taskNameRequired",
      ),
      "Validation errors must go through failValidation, not raw banner writes",
    );
  });

  test("hiding a focusable container rescues keyboard focus", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );
    const rescueSource = extractFunctionSource(source, "rescueFocusFrom");

    for (const token of [
      "var active = document.activeElement",
      "!container.contains(active)",
      "fallbackElement.focus()",
      "active.blur()",
    ]) {
      assert.ok(
        sourceContainsToken(rescueSource, token),
        `Expected token not found in rescueFocusFrom: ${token}`,
      );
    }

    for (const callSite of [
      "rescueFocusFrom( templateSelectGroup,",
      "rescueFocusFrom(el, friendlyFrequency)",
      "rescueFocusFrom(modelVariantGroup, modelSelect)",
      "rescueFocusFrom(templateSelectGroup, sourceElement)",
    ]) {
      assert.ok(
        sourceContainsToken(source, callSite),
        `Expected focus rescue call site not found: ${callSite}`,
      );
    }
  });

  test("webview rejects mismatched and older prompt previews", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");
    const messageHandler = extractBlockFromStartToken(
      source,
      'case "updatePromptPreviews":',
    );

    const expectedTokens = [
      'String(preview.promptPath || "") !==',
      'String(task.promptPath || "").trim()',
      "Date.parse(existing.resolvedAt) > Date.parse(preview.resolvedAt)",
      "updatePromptFileNotice()",
    ];
    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(messageHandler, token),
        `Expected token not found in preview message flow: ${token}`,
      );
    }
  });

  test("editTask re-establishes template baseline after prompt source apply", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const editSource = extractBlockFromStartToken(
      source,
      "window.editTask = function (id) {",
    );

    const orderedTokens = [
      "applyPromptSource(sourceValue, true);",
      'pendingTemplatePath = task.promptPath || "";',
      'if (sourceValue === "inline")',
      "setTemplatePromptBaseline(null);",
      'setTemplatePromptBaseline(String(promptTextEl.value || ""));',
    ];

    assertTokensInOrder(
      editSource,
      orderedTokens,
      "Expected token not found in editTask baseline flow",
    );
  });

  test("deleteTask posts to extension without local task lookup", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const deleteStart = source.indexOf("window.deleteTask = function (id) {");
    assert.ok(deleteStart >= 0, "window.deleteTask was not found.");

    const handlerEnd = source.indexOf("};", deleteStart);
    assert.ok(handlerEnd > deleteStart, "window.deleteTask end was not found.");

    const deleteSource = source.slice(deleteStart, handlerEnd + 2);

    assert.ok(
      sourceContainsToken(
        deleteSource,
        'vscode.postMessage({ type: "deleteTask", taskId: id });',
      ),
      "window.deleteTask should post deleteTask message.",
    );
    assert.ok(
      !deleteSource.includes("tasks.find("),
      "window.deleteTask should not rely on local tasks.find lookup.",
    );
  });

  test("Message handler catch keeps create-tab recovery flow", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const messageHandlerStart = source.indexOf(
      'window.addEventListener("message",',
    );
    assert.ok(messageHandlerStart >= 0, "Message handler was not found.");

    const handlerEnd = source.indexOf(
      'vscode.postMessage({ type: "webviewReady" });',
      messageHandlerStart,
    );
    assert.ok(
      handlerEnd > messageHandlerStart,
      "Message handler end anchor was not found.",
    );

    const handlerSource = source.slice(messageHandlerStart, handlerEnd);
    const outerCatchPattern = /\n\s*\}\s*catch\s*\(e\)\s*\{/g;
    let catchStart = -1;
    let match: RegExpExecArray | null = null;
    while ((match = outerCatchPattern.exec(handlerSource)) !== null) {
      catchStart = match.index;
    }
    assert.ok(
      catchStart >= 0,
      "Expected outer message-handler catch block was not found.",
    );

    const catchBraceStart = handlerSource.indexOf("{", catchStart);
    assert.ok(
      catchBraceStart >= 0,
      "Expected opening brace for catch block was not found.",
    );

    let depth = 0;
    let catchEnd = -1;
    for (let i = catchBraceStart; i < handlerSource.length; i++) {
      const ch = handlerSource[i];
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          catchEnd = i + 1;
          break;
        }
      }
    }
    assert.ok(catchEnd > catchBraceStart, "Catch block end was not found.");

    const catchSource = handlerSource.slice(catchStart, catchEnd);

    const recoveryTokensInOrder = [
      "sanitizeAbsolutePaths(rawError)",
      "showFormError(prefix + displayError)",
      "clearPendingSubmitState()",
      'switchTab("create")',
    ];

    assertTokensInOrder(
      catchSource,
      recoveryTokensInOrder,
      "Expected token not found in catch flow",
    );
  });

  test("Unhandled rejection path falls back to localized unknown text", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const unhandledStart = source.indexOf("window.onunhandledrejection");
    assert.ok(
      unhandledStart >= 0,
      "onunhandledrejection handler was not found.",
    );

    const acquireApiAnchor = source.indexOf(
      'if (typeof acquireVsCodeApi === "function")',
      unhandledStart,
    );
    assert.ok(
      acquireApiAnchor > unhandledStart,
      "onunhandledrejection handler end anchor was not found.",
    );

    const unhandledSource = source.slice(unhandledStart, acquireApiAnchor);

    const expectedTokensInOrder = [
      "raw = String(raw).split(/\\r?\\n/)[0];",
      "var safeRaw = sanitizeAbsolutePaths(raw);",
      "var displayRaw = safeRaw.trim()",
      "? safeRaw",
      ': String(strings.webviewUnknown || "");',
      "showFormError(prefix + displayRaw);",
    ];

    assertTokensInOrder(
      unhandledSource,
      expectedTokensInOrder,
      "Expected token not found in unhandled rejection flow",
    );
  });

  test("list tab HTML exposes summary cards and create shortcut", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/schedulerWebview.ts"),
      "utf8",
    );

    const expectedTokens = [
      'id="open-create-btn"',
      'id="summary-total"',
      'id="summary-enabled"',
      'id="summary-paused"',
      'data-open-create="true"',
      "strings.emptyStateDescription",
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(source, token),
        `Expected list-tab summary token not found: ${token}`,
      );
    }
  });

  test("initial HTML includes grouped model picker controls", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/schedulerWebview.ts"),
      "utf8",
    );

    const expectedTokens = [
      "const initialModelPickerPayload = this.buildModelPickerPayload(initialModels);",
      "modelPickerDefault: initialModelPickerPayload.modelPickerDefault",
      'id="model-experimental-note"',
      'id="model-variant-group"',
      'id="model-variant-select"',
      'id="model-selection-status"',
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(source, token),
        `Expected initial model option token not found: ${token}`,
      );
    }

    const removedTokens = [
      'id="show-all-models"',
      "modelPickerAll: initialModelPickerPayload.modelPickerAll",
    ];

    for (const token of removedTokens) {
      assert.ok(
        !sourceContainsToken(source, token),
        `Initial HTML should no longer include token: ${token}`,
      );
    }
  });

  test("allowed time window UI uses explicit enable checkbox", () => {
    const htmlSource = fs.readFileSync(
      path.resolve(__dirname, "../../../src/schedulerWebview.ts"),
      "utf8",
    );
    const scriptSource = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );

    const expectedHtmlTokens = [
      "labelAllowedTimeWindowEnabled:",
      'id="allowed-time-enabled"',
      'id="allowed-time-fields"',
      "strings.labelAllowedTimeWindowEnabled",
    ];

    for (const token of expectedHtmlTokens) {
      assert.ok(
        sourceContainsToken(htmlSource, token),
        `Expected allowed time window HTML token not found: ${token}`,
      );
    }

    const expectedScriptTokens = [
      'document.getElementById("allowed-time-enabled")',
      "function setAllowedTimeWindowEnabled(enabled, clearValues) {",
      'allowedTimeFields.classList.toggle("disabled", !isEnabled);',
      "allowedTimeStartInput.disabled = !isEnabled;",
      "var isAllowedTimeWindowEnabled = allowedTimeEnabledInput",
      "setAllowedTimeWindowEnabled(false, false);",
      "setAllowedTimeWindowEnabled(\n      !!(task.allowedTimeStart || task.allowedTimeEnd),",
      'allowedTimeEnabledInput.addEventListener("change", function () {',
    ];

    for (const token of expectedScriptTokens) {
      assert.ok(
        sourceContainsToken(scriptSource, token),
        `Expected allowed time window script token not found: ${token}`,
      );
    }
  });

  test("webview script removes stale show-all-models references", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );

    const removedTokens = ["showAllModelsInput"];

    for (const token of removedTokens) {
      assert.ok(
        !sourceContainsToken(source, token),
        `Webview script should no longer reference removed model toggle token: ${token}`,
      );
    }
  });

  test("renderTaskList updates summary counters and empty-state create CTA", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );

    const renderSource = extractBlockFromStartToken(
      source,
      "function renderTaskList(nextTasks) {",
    );

    const expectedTokens = [
      "summaryTotal.textContent = String(taskItems.length);",
      "summaryEnabled.textContent = String(enabledCount);",
      "summaryPaused.textContent = String(taskItems.length - enabledCount);",
      'data-open-create="true"',
      'escapeHtml(strings.emptyStateDescription || "")',
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(renderSource, token),
        `Expected task list summary token not found: ${token}`,
      );
    }
  });

  test("task cards use edit-title interaction and labeled action chips", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );

    const renderSource = extractBlockFromStartToken(
      source,
      "function renderTaskList(nextTasks) {",
    );

    const expectedTokens = [
      'class="task-title-button task-name" data-action="edit"',
      'class="btn-primary action-chip" data-action="run"',
      'class="btn-secondary action-chip" data-action="toggle"',
      "escapeHtml(strings.actionDelete)",
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(renderSource, token),
        `Expected labeled action token not found: ${token}`,
      );
    }

    assert.ok(
      !renderSource.includes('task-name clickable" data-action="toggle"'),
      "Task title should no longer toggle enabled state directly.",
    );
  });

  test("updateModelOptions renders grouped model entries and variant metadata", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );

    const updateModelOptionsSource = extractBlockFromStartToken(
      source,
      "function updateModelOptions(selection) {",
    );

    const updateVariantOptionsSource = extractBlockFromStartToken(
      source,
      "function updateModelVariantOptions(group, selection) {",
    );

    const groupTokens = [
      "var groups = Array.isArray(getActiveModelPickerGroups())",
      'escapeAttr(group.key || "")',
      'escapeHtml(group.label || "")',
      "updateModelVariantOptions(selectedGroup, selection);",
    ];

    for (const token of groupTokens) {
      assert.ok(
        sourceContainsToken(updateModelOptionsSource, token),
        `Expected updateModelOptions token not found: ${token}`,
      );
    }

    const variantTokens = [
      'data-model-id="',
      'escapeAttr(model.id || "")',
      'data-model-name="',
      'escapeAttr(model.name || "")',
      'data-model-vendor="',
      'escapeAttr(model.vendor || "")',
      'data-model-family="',
      'escapeAttr(model.family || "")',
      'data-model-version="',
      'escapeAttr(model.version || "")',
      'data-model-reasoning-effort="',
      'escapeAttr(variant.reasoningEffort || "")',
      "variants.length <= 1",
      "escapeHtml(",
      'variant.label || model.label || model.name || model.id || ""',
    ];

    for (const token of variantTokens) {
      assert.ok(
        sourceContainsToken(updateVariantOptionsSource, token),
        `Expected updateModelVariantOptions token not found: ${token}`,
      );
    }
  });

  test("webview refresh builds default and expanded model picker payloads", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/schedulerWebview.ts"),
      "utf8",
    );

    const expectedTokens = [
      "buildModelPickerGroups,",
      "filterPickerModelCatalog,",
      "modelPickerDefault: relabelDefaultVariant(",
      "includeExperimentalModelQualityVariants:",
      "experimentalModelQualityEnabled",
      "messages.labelModelExperimentalNote()",
      "this.cachedModels = this.localizeCachedModels(result.models);",
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(source, token),
        `Expected picker filter token not found: ${token}`,
      );
    }

    const removedTokens = [
      "filterExpandedPickerModelCatalog,",
      "modelPickerAll: relabelDefaultVariant(",
      "buildModelPickerGroups(filterExpandedPickerModelCatalog(models))",
    ];

    for (const token of removedTokens) {
      assert.ok(
        !sourceContainsToken(source, token),
        `Picker payload should no longer include token: ${token}`,
      );
    }
  });

  test("model catalog diagnostics include reasoning effort metadata", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/extension.ts"),
      "utf8",
    );

    const expectedTokens = [
      "readSafeLanguageModelSettings",
      "safeModelSettings",
      "relatedSettings: readRelevantReasoningSettings()",
      "languageModelsConfig:",
      "key: variant.key",
      "reasoningEffort: variant.reasoningEffort",
      "github.copilot.chat.reasoningEffortOverride",
      "github.copilot.chat.responsesApiReasoningEffort",
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(source, token),
        `Expected diagnostic reasoning effort token not found: ${token}`,
      );
    }
  });

  test("unresolved saved model selections remain visible in the webview", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );

    const expectedTokens = [
      'var modelSelectionStatus = document.getElementById("model-selection-status")',
      "function ensureUnavailableModelOption(selectEl, selection) {",
      'option.dataset.unresolved = "true"',
      "option.dataset.modelId = modelId",
      'strings.labelModelUnavailableNote || ""',
      "option.dataset.modelReasoningEffort = String(",
      "getSelectedVariantOption() || getSelectedBaseModelOption()",
      "return ensureUnavailableModelOption(modelSelect, selection);",
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(source, token),
        `Expected unresolved model token not found: ${token}`,
      );
    }
  });

  test("edit submit path diffs unchanged fields before posting updateTask", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../media/schedulerWebview.js"),
      "utf8",
    );

    const expectedTokens = [
      "var editingTaskSnapshot = null;",
      "var editingTaskNormalizedSnapshot = null;",
      "function normalizeTaskForEditDiff(task) {",
      "function buildTaskUpdateData(taskData) {",
      "editingTaskSnapshot = null;",
      "editingTaskNormalizedSnapshot = null;",
      "editingTaskSnapshot = Object.assign({}, task);",
      "editingTaskNormalizedSnapshot = normalizeTaskForEditDiff(task);",
      "var normalizedOriginal = editingTaskNormalizedSnapshot;",
      "var submittedTaskData = editingTaskId",
      "? buildTaskUpdateData(taskData)",
      "data: submittedTaskData,",
    ];

    for (const token of expectedTokens) {
      assert.ok(
        sourceContainsToken(source, token),
        `Expected edit diff token not found: ${token}`,
      );
    }
  });
});

suite("Sanitizer Contract Sync Tests", () => {
  test("Critical sanitizer token sets stay aligned between extension and webview", () => {
    const webviewScriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const extensionSanitizerPath = path.resolve(
      __dirname,
      "../../../src/errorSanitizer.ts",
    );

    const webviewSource = fs.readFileSync(webviewScriptPath, "utf8");
    const extensionSource = fs.readFileSync(extensionSanitizerPath, "utf8");

    const webviewSensitiveSource = extractFunctionSource(
      webviewSource,
      "sanitizeSensitiveDetails",
    );
    const extensionSensitiveSource = extractFunctionSource(
      extensionSource,
      "sanitizeSensitiveDetails",
    );
    const webviewPathSource = extractFunctionSource(
      webviewSource,
      "sanitizeAbsolutePaths",
    );
    const extensionPathSource = extractFunctionSource(
      extensionSource,
      "sanitizeAbsolutePathDetails",
    );

    const sensitiveTokens = [
      "Authorization\\s*:\\s*(?:Bearer|Basic|Token)",
      "access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|password|passwd",
    ];
    const pathTokens = [
      "open|stat|lstat|scandir|unlink|readFile|writeFile|rename|mkdir|rmdir|readdir|readlink|realpath|opendir|copyfile|access|chmod",
    ];

    for (const token of sensitiveTokens) {
      assert.ok(
        extensionSensitiveSource.includes(token),
        `Extension sensitive-detail sanitizer is missing token set: ${token}`,
      );
      assert.ok(
        webviewSensitiveSource.includes(token),
        `Webview sensitive-detail sanitizer is missing token set: ${token}`,
      );
    }

    for (const token of pathTokens) {
      assert.ok(
        extensionPathSource.includes(token),
        `Extension path sanitizer is missing token set: ${token}`,
      );
      assert.ok(
        webviewPathSource.includes(token),
        `Webview path sanitizer is missing token set: ${token}`,
      );
    }
  });
});

suite("Sanitizer Behavior Parity Tests", () => {
  test("Extension and webview sanitizers produce identical outputs", async () => {
    const { __testOnly } = await import("../../extension");
    const extSanitize = __testOnly.sanitizeErrorDetailsForLog as
      | ((message: string) => string)
      | undefined;
    const webviewSanitize = loadWebviewSanitizeFunction(
      messages.redactedPlaceholder(),
    );

    assert.ok(typeof extSanitize === "function");
    assert.ok(typeof webviewSanitize === "function");

    runSanitizerParityCases(extSanitize!, webviewSanitize);
  });
});

suite("SchedulerWebview Error Detail Sanitization Tests", () => {
  test("Sanitizes absolute paths to basenames (Windows and POSIX)", () => {
    const wv = SchedulerWebview as unknown as {
      sanitizeErrorDetailsForUser?: (message: string) => string;
    };

    assert.ok(typeof wv.sanitizeErrorDetailsForUser === "function");

    const sanitize = wv.sanitizeErrorDetailsForUser!;

    runSharedSanitizerCases(sanitize, messages.redactedPlaceholder());
  });

  test("Falls back to localized unknown on empty/whitespace outputs", () => {
    const wv = SchedulerWebview as unknown as {
      sanitizeErrorDetailsForUser?: (message: string) => string;
    };

    assert.ok(typeof wv.sanitizeErrorDetailsForUser === "function");
    const sanitize = wv.sanitizeErrorDetailsForUser!;

    assert.strictEqual(sanitize(""), messages.webviewUnknown());
    assert.strictEqual(sanitize("   \t\n"), messages.webviewUnknown());
  });
});

suite("SchedulerWebview showError Sanitization Tests", () => {
  test("showError sanitizes absolute paths before posting", () => {
    const wv = SchedulerWebview as unknown as {
      panel?: WebviewPanelLike;
      webviewReady?: boolean;
      pendingMessages?: unknown[];
    };

    const originalPanel = wv.panel;
    const originalReady = wv.webviewReady;
    const originalPending = wv.pendingMessages;

    const sent: unknown[] = [];

    try {
      wv.panel = {
        webview: {
          postMessage: (message: unknown) => {
            sent.push(message);
            return Promise.resolve(true);
          },
        },
      };
      wv.webviewReady = true;
      wv.pendingMessages = [];

      SchedulerWebview.showError(
        "ENOENT: no such file or directory, open 'C:\\Users\\me\\secret folder\\a b.md'",
      );

      assert.strictEqual(sent.length, 1);
      const m = sent[0] as { type?: unknown; text?: unknown };
      assert.strictEqual(m.type, "showError");
      assert.ok(typeof m.text === "string");
      assert.ok(!(m.text as string).includes("C:\\Users\\me"));
      assert.ok((m.text as string).includes("a b.md"));
    } finally {
      wv.panel = originalPanel;
      wv.webviewReady = originalReady;
      wv.pendingMessages = originalPending;
    }
  });

  test("showError falls back to localized unknown text when message is empty", () => {
    const wv = SchedulerWebview as unknown as {
      panel?: WebviewPanelLike;
      webviewReady?: boolean;
      pendingMessages?: unknown[];
    };

    const originalPanel = wv.panel;
    const originalReady = wv.webviewReady;
    const originalPending = wv.pendingMessages;

    const sent: unknown[] = [];

    try {
      wv.panel = {
        webview: {
          postMessage: (message: unknown) => {
            sent.push(message);
            return Promise.resolve(true);
          },
        },
      };
      wv.webviewReady = true;
      wv.pendingMessages = [];

      SchedulerWebview.showError("");

      assert.strictEqual(sent.length, 1);
      const m = sent[0] as { type?: unknown; text?: unknown };
      assert.strictEqual(m.type, "showError");
      assert.strictEqual(m.text, messages.webviewUnknown());
    } finally {
      wv.panel = originalPanel;
      wv.webviewReady = originalReady;
      wv.pendingMessages = originalPending;
    }
  });

  test("showError falls back to localized unknown text when message is whitespace only", () => {
    const wv = SchedulerWebview as unknown as {
      panel?: WebviewPanelLike;
      webviewReady?: boolean;
      pendingMessages?: unknown[];
    };

    const originalPanel = wv.panel;
    const originalReady = wv.webviewReady;
    const originalPending = wv.pendingMessages;

    const sent: unknown[] = [];

    try {
      wv.panel = {
        webview: {
          postMessage: (message: unknown) => {
            sent.push(message);
            return Promise.resolve(true);
          },
        },
      };
      wv.webviewReady = true;
      wv.pendingMessages = [];

      SchedulerWebview.showError("   ");

      assert.strictEqual(sent.length, 1);
      const m = sent[0] as { type?: unknown; text?: unknown };
      assert.strictEqual(m.type, "showError");
      assert.strictEqual(m.text, messages.webviewUnknown());
    } finally {
      wv.panel = originalPanel;
      wv.webviewReady = originalReady;
      wv.pendingMessages = originalPending;
    }
  });
});

suite("SchedulerWebview Template Load Error Feedback Tests", () => {
  test("Template load failure posts showError to webview", async () => {
    const wv = SchedulerWebview as unknown as {
      panel?: WebviewPanelLike;
      webviewReady?: boolean;
      pendingMessages?: unknown[];
      cachedPromptTemplates?: unknown[];
      loadPromptTemplateContent?: (
        templatePath: string,
        source: "local" | "global",
      ) => Promise<void>;
    };

    const originalPanel = wv.panel;
    const originalReady = wv.webviewReady;
    const originalPending = wv.pendingMessages;
    const originalTemplates = wv.cachedPromptTemplates;

    const sent: unknown[] = [];

    try {
      wv.panel = {
        webview: {
          postMessage: (message: unknown) => {
            sent.push(message);
            return Promise.resolve(true);
          },
        },
      };
      wv.webviewReady = true;
      wv.pendingMessages = [];
      wv.cachedPromptTemplates = [];

      assert.ok(typeof wv.loadPromptTemplateContent === "function");

      await wv.loadPromptTemplateContent!(
        "C:\\outside\\not-allowed.md",
        "local",
      );

      const showErrorMessage = (
        sent as Array<{ type?: unknown; text?: unknown }>
      ).find((m) => m.type === "showError");
      assert.ok(showErrorMessage);
      assert.strictEqual(showErrorMessage?.text, messages.templateLoadError());
    } finally {
      wv.panel = originalPanel;
      wv.webviewReady = originalReady;
      wv.pendingMessages = originalPending;
      wv.cachedPromptTemplates = originalTemplates;
    }
  });

  test("showError handler clears template-loading submit guard", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    const showErrorCaseStart = source.indexOf('case "showError":');
    assert.ok(showErrorCaseStart >= 0, "showError case was not found.");

    const showErrorCaseEnd = source.indexOf(
      "} catch (e) {",
      showErrorCaseStart,
    );
    assert.ok(
      showErrorCaseEnd > showErrorCaseStart,
      "showError case end was not found.",
    );

    const showErrorCaseSource = source.slice(
      showErrorCaseStart,
      showErrorCaseEnd,
    );

    const expectedTokensInOrder = [
      "showFormError(displayText, 8000)",
      "clearTemplateLoading()",
      "clearPendingSubmitState()",
      'switchTab("create")',
    ];

    assertTokensInOrder(
      showErrorCaseSource,
      expectedTokensInOrder,
      "Expected token not found",
    );
  });

  test("refreshCachesAndNotifyPanel keeps cached templates on refresh failure", async () => {
    const wv = SchedulerWebview as unknown as {
      panel?: WebviewPanelLike;
      webviewReady?: boolean;
      pendingMessages?: unknown[];
      cachedPromptTemplates?: unknown[];
      hasShownPromptTemplateRefreshError?: boolean;
      refreshAgentsAndModels?: (force?: boolean) => Promise<void>;
      refreshPromptTemplates?: (force?: boolean) => Promise<void>;
      refreshCachesAndNotifyPanel?: (force?: boolean) => Promise<void>;
    };

    const originalPanel = wv.panel;
    const originalReady = wv.webviewReady;
    const originalPending = wv.pendingMessages;
    const originalTemplates = wv.cachedPromptTemplates;
    const originalRefreshAgentsAndModels = wv.refreshAgentsAndModels;
    const originalRefreshPromptTemplates = wv.refreshPromptTemplates;
    const originalErrorShown = wv.hasShownPromptTemplateRefreshError;

    const sent: unknown[] = [];
    const cachedTemplates = [{ path: "a.md", name: "alpha", source: "local" }];

    try {
      wv.panel = {
        webview: {
          postMessage: (message: unknown) => {
            sent.push(message);
            return Promise.resolve(true);
          },
        },
      };
      wv.webviewReady = true;
      wv.pendingMessages = [];
      wv.cachedPromptTemplates = cachedTemplates;
      wv.hasShownPromptTemplateRefreshError = false;
      wv.refreshAgentsAndModels = async () => {};
      wv.refreshPromptTemplates = async () => {
        throw new Error("template refresh failed");
      };

      assert.ok(typeof wv.refreshCachesAndNotifyPanel === "function");

      await wv.refreshCachesAndNotifyPanel!(true);
      await wv.refreshCachesAndNotifyPanel!(true);

      assert.deepStrictEqual(wv.cachedPromptTemplates, cachedTemplates);

      const templateUpdates = (
        sent as Array<{ type?: unknown; templates?: unknown }>
      ).filter((message) => message.type === "updatePromptTemplates");
      assert.ok(templateUpdates.length >= 1);
      assert.deepStrictEqual(templateUpdates[0]?.templates, cachedTemplates);

      const showErrors = (
        sent as Array<{ type?: unknown; text?: unknown }>
      ).filter((message) => message.type === "showError");
      assert.strictEqual(showErrors.length, 1);
      assert.strictEqual(showErrors[0]?.text, messages.templateLoadError());
    } finally {
      wv.panel = originalPanel;
      wv.webviewReady = originalReady;
      wv.pendingMessages = originalPending;
      wv.cachedPromptTemplates = originalTemplates;
      wv.refreshAgentsAndModels = originalRefreshAgentsAndModels;
      wv.refreshPromptTemplates = originalRefreshPromptTemplates;
      wv.hasShownPromptTemplateRefreshError = originalErrorShown;
    }
  });

  test("refreshPrompts keeps cached templates and shows template error on failure", async () => {
    const wv = SchedulerWebview as unknown as {
      panel?: WebviewPanelLike;
      webviewReady?: boolean;
      pendingMessages?: unknown[];
      cachedPromptTemplates?: unknown[];
      hasShownPromptTemplateRefreshError?: boolean;
      refreshPromptTemplates?: (force?: boolean) => Promise<void>;
      handleMessage?: (message: { type: "refreshPrompts" }) => Promise<void>;
    };

    const originalPanel = wv.panel;
    const originalReady = wv.webviewReady;
    const originalPending = wv.pendingMessages;
    const originalTemplates = wv.cachedPromptTemplates;
    const originalRefreshPromptTemplates = wv.refreshPromptTemplates;
    const originalErrorShown = wv.hasShownPromptTemplateRefreshError;

    const sent: unknown[] = [];
    const cachedTemplates = [{ path: "a.md", name: "alpha", source: "local" }];

    try {
      wv.panel = {
        webview: {
          postMessage: (message: unknown) => {
            sent.push(message);
            return Promise.resolve(true);
          },
        },
      };
      wv.webviewReady = true;
      wv.pendingMessages = [];
      wv.cachedPromptTemplates = cachedTemplates;
      wv.hasShownPromptTemplateRefreshError = true;
      wv.refreshPromptTemplates = async () => {
        throw new Error("template refresh failed");
      };

      assert.ok(typeof wv.handleMessage === "function");

      await wv.handleMessage!({ type: "refreshPrompts" });

      assert.deepStrictEqual(wv.cachedPromptTemplates, cachedTemplates);
      assert.strictEqual(wv.hasShownPromptTemplateRefreshError, true);

      const templateUpdates = (
        sent as Array<{ type?: unknown; templates?: unknown }>
      ).filter((message) => message.type === "updatePromptTemplates");
      assert.strictEqual(templateUpdates.length, 1);
      assert.deepStrictEqual(templateUpdates[0]?.templates, cachedTemplates);

      const showErrors = (
        sent as Array<{ type?: unknown; text?: unknown }>
      ).filter((message) => message.type === "showError");
      assert.strictEqual(showErrors.length, 1);
      assert.strictEqual(showErrors[0]?.text, messages.templateLoadError());
    } finally {
      wv.panel = originalPanel;
      wv.webviewReady = originalReady;
      wv.pendingMessages = originalPending;
      wv.cachedPromptTemplates = originalTemplates;
      wv.refreshPromptTemplates = originalRefreshPromptTemplates;
      wv.hasShownPromptTemplateRefreshError = originalErrorShown;
    }
  });

  test("resetWebviewReadyState clears the prompt template refresh error guard", () => {
    const wv = SchedulerWebview as unknown as {
      webviewReady?: boolean;
      pendingMessages?: unknown[];
      hasShownPromptTemplateRefreshError?: boolean;
      resetWebviewReadyState?: () => void;
    };

    const originalReady = wv.webviewReady;
    const originalPending = wv.pendingMessages;
    const originalErrorShown = wv.hasShownPromptTemplateRefreshError;

    try {
      wv.webviewReady = true;
      wv.pendingMessages = [{ type: "updatePromptTemplates" }];
      wv.hasShownPromptTemplateRefreshError = true;

      assert.ok(typeof wv.resetWebviewReadyState === "function");
      wv.resetWebviewReadyState();

      assert.strictEqual(wv.webviewReady, false);
      assert.deepStrictEqual(wv.pendingMessages, []);
      assert.strictEqual(wv.hasShownPromptTemplateRefreshError, false);
    } finally {
      wv.webviewReady = originalReady;
      wv.pendingMessages = originalPending;
      wv.hasShownPromptTemplateRefreshError = originalErrorShown;
    }
  });

  test("webview script uses displayName when rendering template options", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../media/schedulerWebview.js",
    );
    const source = fs.readFileSync(scriptPath, "utf8");
    const updateTemplateOptionsBlock = extractFunctionSource(
      source,
      "updateTemplateOptions",
    );

    assert.ok(
      sourceContainsToken(
        updateTemplateOptionsBlock,
        'var displayName = t.displayName || t.name || "";',
      ),
      "template option rendering should prefer displayName over name.",
    );
    assert.ok(
      sourceContainsToken(
        updateTemplateOptionsBlock,
        "escapeHtml(displayName)",
      ),
      "template option rendering should escape the resolved display name.",
    );
  });

  test("prompt template discovery uses Uri-based directory traversal", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-webview-templates-"),
    );
    const workspaceOne = path.join(tempRoot, "ws-one");
    const workspaceTwo = path.join(tempRoot, "ws-two");
    const globalPromptsRoot = path.join(tempRoot, "global-prompts");

    const wv = SchedulerWebview as unknown as {
      getPromptTemplates?: () => Promise<
        Array<{
          path: string;
          name: string;
          source: "local" | "global";
          displayName?: string;
        }>
      >;
    };

    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    const originalGetConfiguration = vscode.workspace.getConfiguration;

    try {
      fs.mkdirSync(path.join(workspaceOne, ".github", "prompts", "team"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(workspaceTwo, ".github", "prompts"), {
        recursive: true,
      });
      fs.mkdirSync(globalPromptsRoot, { recursive: true });

      fs.writeFileSync(
        path.join(workspaceOne, ".github", "prompts", "daily.prompt.md"),
        "daily",
        "utf8",
      );
      fs.writeFileSync(
        path.join(workspaceOne, ".github", "prompts", "team", "shared.md"),
        "shared one",
        "utf8",
      );
      fs.writeFileSync(
        path.join(workspaceOne, ".github", "prompts", "ignore.agent.md"),
        "agent",
        "utf8",
      );
      fs.writeFileSync(
        path.join(workspaceTwo, ".github", "prompts", "shared.md"),
        "shared two",
        "utf8",
      );
      fs.writeFileSync(
        path.join(globalPromptsRoot, "shared.md"),
        "shared global",
        "utf8",
      );
      fs.writeFileSync(
        path.join(globalPromptsRoot, "ignored.instructions.md"),
        "instructions",
        "utf8",
      );

      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        value: [
          {
            index: 0,
            name: "ws-one",
            uri: vscode.Uri.file(workspaceOne),
          },
          {
            index: 1,
            name: "ws-two",
            uri: vscode.Uri.file(workspaceTwo),
          },
        ] satisfies vscode.WorkspaceFolder[],
        configurable: true,
      });

      (
        vscode.workspace as typeof vscode.workspace & {
          getConfiguration: typeof vscode.workspace.getConfiguration;
        }
      ).getConfiguration = ((section?: string) => {
        const config = originalGetConfiguration.call(vscode.workspace, section);
        if (section !== "copilotScheduler") {
          return config;
        }
        return {
          ...config,
          get<T>(key: string, defaultValue?: T): T {
            if (key === "globalPromptsPath") {
              return globalPromptsRoot as T;
            }
            return config.get<T>(key, defaultValue as T);
          },
        } as vscode.WorkspaceConfiguration;
      }) as typeof vscode.workspace.getConfiguration;

      assert.ok(typeof wv.getPromptTemplates === "function");

      const templates = await wv.getPromptTemplates!();
      const fileNames = templates.map((template) =>
        path.basename(template.path),
      );

      assert.ok(fileNames.includes("daily.prompt.md"));
      assert.ok(!fileNames.includes("ignore.agent.md"));
      assert.ok(!fileNames.includes("ignored.instructions.md"));

      const daily = templates.find(
        (template) => path.basename(template.path) === "daily.prompt.md",
      );
      assert.ok(daily);
      assert.strictEqual(daily?.name, "daily");
      assert.strictEqual(daily?.displayName, undefined);

      const sharedTemplates = templates.filter(
        (template) => template.name === "shared",
      );
      assert.strictEqual(sharedTemplates.length, 3);
      assert.ok(
        sharedTemplates.every(
          (template) =>
            typeof template.displayName === "string" &&
            template.displayName.startsWith("shared ("),
        ),
      );
      assert.strictEqual(
        new Set(sharedTemplates.map((template) => template.displayName)).size,
        3,
      );
    } finally {
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        value: originalWorkspaceFolders,
        configurable: true,
      });
      (
        vscode.workspace as typeof vscode.workspace & {
          getConfiguration: typeof vscode.workspace.getConfiguration;
        }
      ).getConfiguration = originalGetConfiguration;
      fs.rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  });
});

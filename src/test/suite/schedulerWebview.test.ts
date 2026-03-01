import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { SchedulerWebview } from "../../schedulerWebview";
import { messages } from "../../i18n";
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

  assert.ok(
    end > braceStart,
    `Function closing brace not found for: ${functionName}`,
  );
  return source.slice(start, end);
}

function extractVarAssignment(source: string, varName: string): string {
  const pattern = new RegExp(`var\\s+${varName}\\s*=\\s*[^;]+;`);
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
});

suite("SchedulerWebview Script Contract Tests", () => {
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

    let cursor = 0;
    for (const token of recoveryTokensInOrder) {
      const index = catchSource.indexOf(token, cursor);
      assert.ok(index >= 0, `Expected token not found in catch flow: ${token}`);
      cursor = index + token.length;
    }
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

    let cursor = 0;
    for (const token of expectedTokensInOrder) {
      const index = unhandledSource.indexOf(token, cursor);
      assert.ok(
        index >= 0,
        `Expected token not found in unhandled rejection flow: ${token}`,
      );
      cursor = index + token.length;
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

    let cursor = 0;
    for (const token of expectedTokensInOrder) {
      const index = showErrorCaseSource.indexOf(token, cursor);
      assert.ok(index >= 0, `Expected token not found: ${token}`);
      cursor = index + token.length;
    }
  });
});

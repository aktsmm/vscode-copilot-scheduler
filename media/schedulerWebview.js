(function () {
  var vscode = null;
  var strings = {};
  var MAX_SANITIZE_OUTPUT_CHARS = 8000;
  var MAX_SANITIZE_INPUT_CHARS = 16000;
  var REDACTED_PLACEHOLDER = "[REDACTED]";
  var formErrorHideTimer = null;

  // Initial data (JSON from inline script tag)
  var initialData = {};
  try {
    var initialScript = document.getElementById("initial-data");
    if (initialScript && initialScript.textContent) {
      initialData = JSON.parse(initialScript.textContent) || {};
    }
  } catch (e) {
    initialData = {};
  }

  strings = initialData.strings || {};
  if (
    typeof strings.redactedPlaceholder === "string" &&
    strings.redactedPlaceholder
  ) {
    REDACTED_PLACEHOLDER = strings.redactedPlaceholder;
  }

  function basenameAny(p) {
    if (!p) return "";
    var s = String(p);
    var i1 = s.lastIndexOf("\\");
    var i2 = s.lastIndexOf("/");
    var i = i1 > i2 ? i1 : i2;
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function basenameFromPathLike(p) {
    if (!p) return "";
    var s = String(p);
    if (/^file:\/\/\/?/i.test(s)) {
      try {
        var u = new URL(s);
        if (u.protocol === "file:") {
          s = decodeURIComponent(u.pathname || "");
          s = s.replace(/^\/([A-Za-z]:[\\/])/, "$1");
        } else {
          s = s.replace(/^file:\/\/\/?/i, "");
        }
      } catch (_e) {
        s = s.replace(/^file:\/\/\/?/i, "");
      }
    }
    return basenameAny(s);
  }

  function sanitizeSensitiveDetails(text) {
    return String(text)
      .replace(
        /(\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        function (_m, prefix) {
          return String(prefix) + REDACTED_PLACEHOLDER;
        },
      )
      .replace(
        /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|password|passwd)=)[^&\s]+/gi,
        function (_m, prefix) {
          return String(prefix) + REDACTED_PLACEHOLDER;
        },
      )
      .replace(
        /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|password|passwd)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        function (_m, prefix) {
          return String(prefix) + REDACTED_PLACEHOLDER;
        },
      );
  }

  function sanitizeAbsolutePaths(text) {
    if (!text) return "";
    var input = String(text);
    if (input.length > MAX_SANITIZE_INPUT_CHARS) {
      input = input.slice(0, MAX_SANITIZE_INPUT_CHARS);
    }
    var maskedInput = sanitizeSensitiveDetails(input);
    var sanitized = maskedInput
      // Quoted file URIs (may include spaces)
      .replace(/'(file:\/\/[^']+)'/gi, function (_m, p1) {
        return "'" + basenameFromPathLike(p1) + "'";
      })
      .replace(/"(file:\/\/[^"]+)"/gi, function (_m, p1) {
        return '"' + basenameFromPathLike(p1) + '"';
      })
      // Unquoted file URIs (no spaces)
      .replace(/file:\/\/[^\s"'`]+/gi, function (m) {
        return basenameFromPathLike(m);
      })
      // Quoted Windows absolute paths / UNC (may include spaces)
      .replace(/'((?:[A-Za-z]:(?:\\|\/)|\\\\)[^']+)'/g, function (_m, p1) {
        return "'" + basenameFromPathLike(p1) + "'";
      })
      .replace(/"((?:[A-Za-z]:(?:\\|\/)|\\\\)[^"]+)"/g, function (_m, p1) {
        return '"' + basenameFromPathLike(p1) + '"';
      })
      .replace(
        /(^|[^A-Za-z0-9_])((?:[A-Za-z]:(?:\\|\/)|\\\\)(?:[^\\\/:"'`\r\n]+[\\/])+[^"'`\r\n]*\s+[^"'`\r\n]*?)(?=$|[)\],:;.!?])/g,
        function (_m, prefix, p1) {
          return String(prefix) + basenameFromPathLike(p1);
        },
      )
      .replace(
        /(^|[^A-Za-z0-9_])((?:[A-Za-z]:(?:\\|\/)|\\\\)[^"'`\r\n]*?\.[A-Za-z0-9]{1,16})(?=$|[\s)\],:;.!?])/g,
        function (_m, prefix, p1) {
          return String(prefix) + basenameFromPathLike(p1);
        },
      )
      // Unquoted Windows absolute paths / UNC (no spaces)
      .replace(
        /(^|[^A-Za-z0-9_])((?:[A-Za-z]:(?:\\|\/)|\\\\)(?:[^\s"'`\\/]+[\\/])+[^\s"'`\\/]+)/g,
        function (_m, prefix, p1) {
          return String(prefix) + basenameFromPathLike(p1);
        },
      )
      .replace(
        /(\b(?:open|stat|lstat|scandir|unlink|readFile|writeFile|rename|mkdir|rmdir|readdir|readlink|realpath|opendir|copyfile|access|chmod)\s+)((?:[A-Za-z]:(?:\\|\/))[^\s"'`\\/]+)(?=$|[\s)\],:;.!?])/gi,
        function (_m, prefix, p1) {
          return String(prefix) + basenameFromPathLike(p1);
        },
      )
      // Quoted POSIX absolute paths (may include spaces)
      .replace(/'(\/[^']+)'/g, function (_m, p1) {
        return "'" + basenameFromPathLike(p1) + "'";
      })
      .replace(/"(\/[^\"]+)"/g, function (_m, p1) {
        return '"' + basenameFromPathLike(p1) + '"';
      })
      .replace(
        /(^|[\s(])(\/(?:[^\/:"'`\r\n]+\/)+[^"'`\r\n]*\s+[^"'`\r\n]*?)(?=$|[)\],:;.!?])/g,
        function (_m, prefix, p1) {
          return String(prefix) + basenameFromPathLike(p1);
        },
      )
      .replace(
        /(^|[\s(])(\/[^"'`\r\n]*?\.[A-Za-z0-9]{1,16})(?=$|[\s)\],:;.!?])/g,
        function (_m, prefix, p1) {
          return String(prefix) + basenameFromPathLike(p1);
        },
      )
      .replace(
        /(\b(?:open|stat|lstat|scandir|unlink|readFile|writeFile|rename|mkdir|rmdir|readdir|readlink|realpath|opendir|copyfile|access|chmod)\s+)(\/[^\s"'`\/]+)(?=$|[\s)\],:;.!?])/gi,
        function (_m, prefix, p1) {
          return String(prefix) + basenameFromPathLike(p1);
        },
      )
      // Unquoted POSIX absolute paths (no spaces) — only when preceded by start/whitespace/(
      .replace(
        /(^|[\s(])(\/[^\s"'`\/]+(?:\/[^\s"'`\/]+)+)/g,
        function (_m, prefix, p1) {
          return String(prefix) + basenameFromPathLike(p1);
        },
      );
    return sanitized.length > MAX_SANITIZE_OUTPUT_CHARS
      ? sanitized.slice(0, MAX_SANITIZE_OUTPUT_CHARS)
      : sanitized;
  }

  function showFormError(text, autoHideMs) {
    var errDiv = document.getElementById("form-error");
    if (!errDiv) return;

    errDiv.textContent = String(text || "");
    errDiv.style.display = "block";

    if (formErrorHideTimer) {
      clearTimeout(formErrorHideTimer);
      formErrorHideTimer = null;
    }

    if (typeof autoHideMs === "number" && autoHideMs > 0) {
      formErrorHideTimer = setTimeout(function () {
        errDiv.style.display = "none";
        formErrorHideTimer = null;
      }, autoHideMs);
    }
  }

  function clearPendingSubmitState() {
    pendingSubmit = false;
    if (submitBtn) submitBtn.disabled = !!templateLoadingPath;
    if (testBtn) testBtn.disabled = !!templateLoadingPath;
  }

  function setTemplatePromptBaseline(value) {
    templatePromptBaseline = typeof value === "string" ? value : null;
  }

  function setTemplateLoading(pathValue) {
    templateLoadingPath = pathValue ? String(pathValue) : "";
    if (submitBtn && !pendingSubmit) {
      submitBtn.disabled = !!templateLoadingPath;
    }
    if (testBtn) {
      testBtn.disabled = !!templateLoadingPath;
    }
  }

  function clearTemplateLoading(pathValue) {
    if (
      pathValue &&
      templateLoadingPath &&
      String(pathValue) !== templateLoadingPath
    ) {
      return;
    }
    templateLoadingPath = "";
    if (submitBtn && !pendingSubmit) {
      submitBtn.disabled = false;
    }
    if (testBtn) {
      testBtn.disabled = false;
    }
  }

  function requestTemplateLoad(selectedPath, source) {
    if (!selectedPath) {
      clearTemplateLoading();
      return;
    }
    setTemplateLoading(selectedPath);
    vscode.postMessage({
      type: "loadPromptTemplate",
      path: selectedPath,
      source: source,
    });
  }

  // Global error handler for debugging (kept minimal to avoid breaking the UI)
  window.onerror = function (msg, url, line, col, error) {
    var prefix = strings.webviewScriptErrorPrefix || "";
    var linePrefix = strings.webviewLinePrefix || "";
    var lineSuffix = strings.webviewLineSuffix || "";
    var rawMsg =
      msg == null ? String(strings.webviewUnknown || "") : String(msg);
    rawMsg = rawMsg.split(/\r?\n/)[0];
    var safeMsg = sanitizeAbsolutePaths(rawMsg);
    var displayMsg = safeMsg.trim()
      ? safeMsg
      : String(strings.webviewUnknown || "");
    var lineInfo =
      typeof line === "number" ? linePrefix + String(line) + lineSuffix : "";
    showFormError(prefix + displayMsg + lineInfo);
    clearTemplateLoading();
    clearPendingSubmitState();
    switchTab("create");
  };

  window.onunhandledrejection = function (ev) {
    var prefix = strings.webviewUnhandledErrorPrefix || "";
    var unknown = strings.webviewUnknown || "";
    var reason = ev && ev.reason ? ev.reason : null;
    var raw = unknown;
    if (reason) {
      if (typeof reason === "string") {
        raw = reason;
      } else if (typeof reason === "object" && reason.message) {
        raw = String(reason.message);
      } else {
        raw = String(reason);
      }
    }
    // Avoid showing multi-line stack traces in UI; keep only the first line.
    raw = String(raw).split(/\r?\n/)[0];
    var safeRaw = sanitizeAbsolutePaths(raw);
    var displayRaw = safeRaw.trim()
      ? safeRaw
      : String(strings.webviewUnknown || "");
    showFormError(prefix + displayRaw);
    clearTemplateLoading();
    clearPendingSubmitState();
    switchTab("create");
  };

  if (typeof acquireVsCodeApi === "function") {
    vscode = acquireVsCodeApi();
  } else {
    // Keep UI usable even if VS Code API is unavailable
    vscode = { postMessage: function () {} };
    showFormError(strings.webviewApiUnavailable || "");
  }

  var tasks = Array.isArray(initialData.tasks) ? initialData.tasks : [];
  var agents = Array.isArray(initialData.agents) ? initialData.agents : [];
  var models = Array.isArray(initialData.models) ? initialData.models : [];
  var modelPickerDefault = Array.isArray(initialData.modelPickerDefault)
    ? initialData.modelPickerDefault
    : [];
  var promptTemplates = Array.isArray(initialData.promptTemplates)
    ? initialData.promptTemplates
    : [];
  var experimentalModelQualityEnabled =
    !!initialData.experimentalModelQualityEnabled;
  var experimentalModelQualityNote =
    typeof initialData.experimentalModelQualityNote === "string"
      ? initialData.experimentalModelQualityNote
      : "";
  var workspacePaths = Array.isArray(initialData.workspacePaths)
    ? initialData.workspacePaths
    : [];
  var caseInsensitivePaths = !!initialData.caseInsensitivePaths;
  var editingTaskId = null;
  var pendingAgentValue = "";
  var pendingModelValue = "";
  var pendingModelName = "";
  var pendingModelVendor = "";
  var pendingModelFamily = "";
  var pendingModelVersion = "";
  var pendingModelReasoningEffort = "";
  var pendingTemplatePath = "";
  var editingTaskEnabled = true;
  var editingTaskCanDelete = false;
  var pendingSubmit = false;
  var templateLoadingPath = "";
  var templatePromptBaseline = null;
  var layoutRefreshPending = false;

  function scheduleLayoutRefresh() {
    if (layoutRefreshPending) return;
    layoutRefreshPending = true;

    var scheduleFrame =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : function (callback) {
            return window.setTimeout(callback, 16);
          };

    scheduleFrame(function () {
      scheduleFrame(function () {
        layoutRefreshPending = false;
        if (document.body) {
          void document.body.offsetHeight;
        }
      });
    });
  }

  var defaultJitterSeconds = (function () {
    var raw = initialData.defaultJitterSeconds;
    var n = typeof raw === "number" ? raw : Number(raw);
    if (!isFinite(n)) return 600;
    var i = Math.floor(n);
    if (i < 0) return 0;
    if (i > 1800) return 1800;
    return i;
  })();
  var defaultAutoMode = !!initialData.defaultAutoMode;
  var defaultChatSession =
    initialData.defaultChatSession === "continue" ? "continue" : "new";
  var defaultChatSessionNote =
    typeof initialData.defaultChatSessionNote === "string"
      ? initialData.defaultChatSessionNote
      : "";
  var defaultScope =
    initialData.defaultScope === "global" ? "global" : "workspace";
  var locale =
    typeof initialData.locale === "string" && initialData.locale
      ? initialData.locale
      : undefined;
  var lastRenderedTasksHtml = "";
  var taskGroupOpenState = {
    global: true,
    "other-workspaces": false,
  };
  var friendlyIntervalMinutes = Array.isArray(
    initialData.friendlyIntervalMinutes,
  )
    ? initialData.friendlyIntervalMinutes
        .map(function (value) {
          return Number(value);
        })
        .filter(function (value) {
          return Number.isFinite(value) && value > 0 && value <= 1440;
        })
    : [
        1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 16, 18, 20, 24, 30, 32, 36, 40, 45,
        48, 60, 72, 80, 90, 96, 120, 180, 240, 360, 480, 720, 1440,
      ];

  // DOM elements - with null safety
  var taskForm = document.getElementById("task-form");
  var taskList = document.getElementById("task-list");
  var editTaskIdInput = document.getElementById("edit-task-id");
  var submitBtn = document.getElementById("submit-btn");
  var testBtn = document.getElementById("test-btn");
  var refreshBtn = document.getElementById("refresh-btn");
  var cronPreset = document.getElementById("cron-preset");
  var cronExpression = document.getElementById("cron-expression");
  var agentSelect = document.getElementById("agent-select");
  var modelSelect = document.getElementById("model-select");
  var modelVariantGroup = document.getElementById("model-variant-group");
  var modelVariantSelect = document.getElementById("model-variant-select");
  var modelExperimentalNote = document.getElementById(
    "model-experimental-note",
  );
  var templateSelect = document.getElementById("template-select");
  var templateSelectGroup = document.getElementById("template-select-group");
  var templateRefreshBtn = document.getElementById("template-refresh-btn");
  var promptGroup = document.getElementById("prompt-group");
  var autoModeInput = document.getElementById("auto-mode");
  var chatSessionSelect = document.getElementById("chat-session");
  var chatSessionNote = document.getElementById("chat-session-note");
  var jitterSecondsInput = document.getElementById("jitter-seconds");
  var maxExecutionsPerDayInput = document.getElementById(
    "max-executions-per-day",
  );
  var allowedTimeEnabledInput = document.getElementById("allowed-time-enabled");
  var allowedTimeFields = document.getElementById("allowed-time-fields");
  var allowedTimeStartInput = document.getElementById("allowed-time-start");
  var allowedTimeEndInput = document.getElementById("allowed-time-end");
  var friendlyFrequency = document.getElementById("friendly-frequency");
  var friendlyInterval = document.getElementById("friendly-interval");
  var friendlyMinute = document.getElementById("friendly-minute");
  var friendlyHour = document.getElementById("friendly-hour");
  var friendlyDow = document.getElementById("friendly-dow");
  var friendlyDom = document.getElementById("friendly-dom");
  var friendlyGenerate = document.getElementById("friendly-generate");
  var openGuruBtn = document.getElementById("open-guru-btn");
  var cronPreviewText = document.getElementById("cron-preview-text");
  var newTaskBtn = document.getElementById("new-task-btn");
  var editDeleteBtn = document.getElementById("edit-delete-btn");
  var openCreateBtn = document.getElementById("open-create-btn");
  var summaryTotal = document.getElementById("summary-total");
  var summaryEnabled = document.getElementById("summary-enabled");
  var summaryPaused = document.getElementById("summary-paused");
  var modelSelectionStatus = document.getElementById("model-selection-status");

  function getSelectedBaseModelOption() {
    if (!modelSelect || modelSelect.selectedIndex < 0) return null;
    return modelSelect.options[modelSelect.selectedIndex] || null;
  }

  function setAllowedTimeWindowEnabled(enabled, clearValues) {
    var isEnabled = !!enabled;
    if (allowedTimeEnabledInput) {
      allowedTimeEnabledInput.checked = isEnabled;
    }
    if (allowedTimeFields) {
      allowedTimeFields.classList.toggle("disabled", !isEnabled);
    }
    if (allowedTimeStartInput) {
      allowedTimeStartInput.disabled = !isEnabled;
      if (!isEnabled && clearValues) {
        allowedTimeStartInput.value = "";
      }
    }
    if (allowedTimeEndInput) {
      allowedTimeEndInput.disabled = !isEnabled;
      if (!isEnabled && clearValues) {
        allowedTimeEndInput.value = "";
      }
    }
  }

  function updateChatSessionDefaultNote() {
    if (!chatSessionNote) return;
    chatSessionNote.textContent = String(defaultChatSessionNote || "");
  }

  function getSelectedVariantOption() {
    if (
      !modelVariantSelect ||
      !modelVariantGroup ||
      modelVariantGroup.style.display === "none" ||
      modelVariantSelect.selectedIndex < 0
    ) {
      return null;
    }
    return modelVariantSelect.options[modelVariantSelect.selectedIndex] || null;
  }

  function getActiveModelPickerGroups() {
    return modelPickerDefault;
  }

  function clearPendingModelSelection() {
    pendingModelValue = "";
    pendingModelName = "";
    pendingModelVendor = "";
    pendingModelFamily = "";
    pendingModelVersion = "";
    pendingModelReasoningEffort = "";
  }

  function buildModelSelectionFromOption(option) {
    if (!option || !option.dataset) return null;
    return {
      model: option.dataset.modelId || option.value || "",
      modelName: option.dataset.modelName || "",
      modelVendor: option.dataset.modelVendor || "",
      modelFamily: option.dataset.modelFamily || "",
      modelVersion: option.dataset.modelVersion || "",
      modelReasoningEffort: option.dataset.modelReasoningEffort || "",
    };
  }

  function findModelPickerGroup(groups, key) {
    if (!Array.isArray(groups) || !key) return null;
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      if (group && group.key === key) {
        return group;
      }
    }
    return null;
  }

  function selectionMatchesModelSelection(
    selection,
    candidate,
    ignoreReasoningEffort,
  ) {
    if (!selection || !candidate) return false;
    var targetId = String(selection.model || "");
    var targetName = String(selection.modelName || "");
    var targetVendor = String(selection.modelVendor || "");
    var targetFamily = String(selection.modelFamily || "");
    var targetVersion = String(selection.modelVersion || "");
    var targetReasoningEffort = String(selection.modelReasoningEffort || "");

    if (targetId) {
      if (String(candidate.model || "") !== targetId) return false;
    } else if (targetName) {
      if (String(candidate.modelName || "") !== targetName) return false;
    } else {
      return false;
    }

    if (targetVendor && String(candidate.modelVendor || "") !== targetVendor) {
      return false;
    }
    if (targetFamily && String(candidate.modelFamily || "") !== targetFamily) {
      return false;
    }
    if (
      targetVersion &&
      String(candidate.modelVersion || "") !== targetVersion
    ) {
      return false;
    }
    if (
      targetReasoningEffort &&
      !ignoreReasoningEffort &&
      String(candidate.modelReasoningEffort || "") !== targetReasoningEffort
    ) {
      return false;
    }

    return true;
  }

  function findModelPickerSelection(groups, selection) {
    if (!Array.isArray(groups) || !selection) return null;
    var fallbackMatch = null;
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      var variants =
        group && Array.isArray(group.variants) ? group.variants : [];
      for (var j = 0; j < variants.length; j++) {
        var variant = variants[j];
        var model = variant ? variant.model || null : null;
        if (!model) continue;
        if (
          selectionMatchesModelSelection(selection, {
            model: model.id || "",
            modelName: model.name || "",
            modelVendor: model.vendor || "",
            modelFamily: model.family || "",
            modelVersion: model.version || "",
            modelReasoningEffort: variant.reasoningEffort || "",
          })
        ) {
          return {
            group: group,
            variant: variant,
          };
        }
        if (
          !fallbackMatch &&
          selectionMatchesModelSelection(
            selection,
            {
              model: model.id || "",
              modelName: model.name || "",
              modelVendor: model.vendor || "",
              modelFamily: model.family || "",
              modelVersion: model.version || "",
              modelReasoningEffort: variant.reasoningEffort || "",
            },
            true,
          )
        ) {
          fallbackMatch = {
            group: group,
            variant: variant,
          };
        }
      }
    }
    return fallbackMatch;
  }

  function clearUnavailableModelOptions(selectEl) {
    if (!selectEl || !selectEl.options) return;
    for (var i = selectEl.options.length - 1; i >= 0; i--) {
      var option = selectEl.options[i];
      if (option && option.dataset && option.dataset.unresolved === "true") {
        selectEl.remove(i);
      }
    }
  }

  function buildUnavailableModelLabel(selection) {
    var base = String(selection.modelName || selection.model || "").trim();
    var suffix = String(strings.labelModelUnavailableSuffix || "").trim();
    if (!base) {
      base = String(selection.model || "").trim();
    }
    return suffix && base ? base + " " + suffix : base;
  }

  function clearModelVariantOptions() {
    if (!modelVariantSelect) return;
    var placeholderText = strings.placeholderSelectModelVariant || "";
    modelVariantSelect.innerHTML =
      '<option value="">' + escapeHtml(placeholderText) + "</option>";
    if (modelVariantGroup) {
      modelVariantGroup.style.display = "none";
    }
    scheduleLayoutRefresh();
  }

  function updateModelExperimentalNote() {
    if (!modelExperimentalNote) return;
    if (experimentalModelQualityEnabled && experimentalModelQualityNote) {
      modelExperimentalNote.textContent = String(experimentalModelQualityNote);
      modelExperimentalNote.style.display = "block";
      return;
    }
    modelExperimentalNote.textContent = "";
    modelExperimentalNote.style.display = "none";
  }

  function updateModelVariantOptions(group, selection) {
    if (!modelVariantSelect) return;

    var variants = group && Array.isArray(group.variants) ? group.variants : [];
    if (variants.length <= 1) {
      clearModelVariantOptions();
      return;
    }

    var placeholderText = strings.placeholderSelectModelVariant || "";
    modelVariantSelect.innerHTML =
      '<option value="">' +
      escapeHtml(placeholderText) +
      "</option>" +
      variants
        .map(function (variant) {
          var model = variant && variant.model ? variant.model : {};
          var label =
            variant.label || model.label || model.name || model.id || "";
          return (
            '<option value="' +
            escapeAttr(variant.key || "") +
            '" data-model-id="' +
            escapeAttr(model.id || "") +
            '" data-model-name="' +
            escapeAttr(model.name || "") +
            '" data-model-vendor="' +
            escapeAttr(model.vendor || "") +
            '" data-model-family="' +
            escapeAttr(model.family || "") +
            '" data-model-version="' +
            escapeAttr(model.version || "") +
            '" data-model-reasoning-effort="' +
            escapeAttr(variant.reasoningEffort || "") +
            '">' +
            escapeHtml(label) +
            "</option>"
          );
        })
        .join("");

    if (modelVariantGroup) {
      modelVariantGroup.style.display = "block";
    }

    var matchedVariantKey = "";
    var matchedSelection = findModelPickerSelection([group], selection);
    if (matchedSelection && matchedSelection.variant) {
      matchedVariantKey = matchedSelection.variant.key || "";
    }

    if (
      matchedVariantKey &&
      selectHasOptionValue(modelVariantSelect, matchedVariantKey)
    ) {
      modelVariantSelect.value = matchedVariantKey;
    } else if (modelVariantSelect.options.length > 1) {
      modelVariantSelect.selectedIndex = 1;
    }

    scheduleLayoutRefresh();
  }

  function getCurrentModelSelection() {
    var selectedVariantOption = getSelectedVariantOption();
    if (selectedVariantOption && selectedVariantOption.dataset) {
      return buildModelSelectionFromOption(selectedVariantOption);
    }

    var selectedModelOption = getSelectedBaseModelOption();
    if (selectedModelOption && selectedModelOption.dataset) {
      var fromBase = buildModelSelectionFromOption(selectedModelOption);
      if (fromBase && (fromBase.model || fromBase.modelName)) {
        return fromBase;
      }
    }

    return null;
  }

  function updateModelSelectionStatus() {
    if (!modelSelectionStatus) return;
    var selectedModelOption =
      getSelectedVariantOption() || getSelectedBaseModelOption();
    if (
      selectedModelOption &&
      selectedModelOption.dataset &&
      selectedModelOption.dataset.unresolved === "true"
    ) {
      modelSelectionStatus.textContent = String(
        strings.labelModelUnavailableNote || "",
      );
      modelSelectionStatus.style.display = "block";
      return;
    }

    modelSelectionStatus.textContent = "";
    modelSelectionStatus.style.display = "none";
  }

  function ensureUnavailableModelOption(selectEl, selection) {
    if (!selectEl || !selection) return false;
    var modelId = String(selection.model || "").trim();
    var modelName = String(selection.modelName || "").trim();
    if (!modelId && !modelName) {
      updateModelSelectionStatus();
      return false;
    }

    clearUnavailableModelOptions(selectEl);
    clearModelVariantOptions();

    var option = document.createElement("option");
    option.value = modelId;
    option.textContent = buildUnavailableModelLabel({
      model: modelId,
      modelName: modelName,
    });
    option.dataset.unresolved = "true";
    option.dataset.modelId = modelId;
    option.dataset.modelName = modelName;
    option.dataset.modelVendor = String(selection.modelVendor || "");
    option.dataset.modelFamily = String(selection.modelFamily || "");
    option.dataset.modelVersion = String(selection.modelVersion || "");
    option.dataset.modelReasoningEffort = String(
      selection.modelReasoningEffort || "",
    );
    selectEl.appendChild(option);
    selectEl.selectedIndex = selectEl.options.length - 1;
    updateModelSelectionStatus();
    return true;
  }

  function updateModelOptions(selection) {
    if (!modelSelect) return false;

    var groups = Array.isArray(getActiveModelPickerGroups())
      ? getActiveModelPickerGroups()
      : [];
    clearUnavailableModelOptions(modelSelect);

    if (groups.length === 0) {
      var noText = strings.placeholderNoModels || "";
      modelSelect.innerHTML =
        '<option value="">' + escapeHtml(noText) + "</option>";
      clearModelVariantOptions();
      updateModelSelectionStatus();
      return false;
    }

    var matchedSelection = findModelPickerSelection(groups, selection);
    var previousGroupKey = modelSelect.value || "";
    var selectText = strings.placeholderSelectModel || "";
    var placeholder =
      '<option value="">' + escapeHtml(selectText) + "</option>";
    modelSelect.innerHTML =
      placeholder +
      groups
        .map(function (group) {
          var defaultVariant =
            group && Array.isArray(group.variants) && group.variants.length > 0
              ? group.variants[0]
              : null;
          var defaultModel =
            defaultVariant && defaultVariant.model ? defaultVariant.model : {};
          return (
            '<option value="' +
            escapeAttr(group.key || "") +
            '" data-model-id="' +
            escapeAttr(defaultModel.id || "") +
            '" data-model-name="' +
            escapeAttr(defaultModel.name || "") +
            '" data-model-vendor="' +
            escapeAttr(defaultModel.vendor || "") +
            '" data-model-family="' +
            escapeAttr(defaultModel.family || "") +
            '" data-model-version="' +
            escapeAttr(defaultModel.version || "") +
            '">' +
            escapeHtml(group.label || "") +
            "</option>"
          );
        })
        .join("");

    if (matchedSelection && matchedSelection.group) {
      modelSelect.value = matchedSelection.group.key || "";
    } else if (
      previousGroupKey &&
      selectHasOptionValue(modelSelect, previousGroupKey)
    ) {
      modelSelect.value = previousGroupKey;
    } else {
      modelSelect.value = "";
    }

    var selectedGroup = findModelPickerGroup(groups, modelSelect.value || "");
    updateModelVariantOptions(selectedGroup, selection);
    updateModelSelectionStatus();
    scheduleLayoutRefresh();
    return selection ? !!matchedSelection : !!selectedGroup;
  }

  function applyModelSelection(selection) {
    if (!selection) {
      updateModelOptions(null);
      return false;
    }

    if (updateModelOptions(selection)) {
      return true;
    }

    return ensureUnavailableModelOption(modelSelect, selection);
  }

  function normalizeWorkspacePath(p) {
    if (!p) return "";
    var s = String(p).replace(/\\/g, "/");
    if (s === "/") return "/";
    s = s.replace(/\/+$/, "");
    if (s === "") return "/";
    return caseInsensitivePaths ? s.toLowerCase() : s;
  }

  function isTaskInCurrentWorkspace(task) {
    if (!task || task.scope !== "workspace") return false;
    var wsPath = task.workspacePath || "";
    if (!wsPath) return false;
    return (workspacePaths || []).some(function (p) {
      return normalizeWorkspacePath(p) === normalizeWorkspacePath(wsPath);
    });
  }

  function getCreateTabButton() {
    return document.querySelector('.tab-button[data-tab="create"]');
  }

  function setCreateTabLabel(isEditing) {
    var btn = getCreateTabButton();
    if (!btn) return;
    var label = isEditing
      ? strings.tabEdit || strings.tabCreate
      : strings.tabCreate;
    if (label) btn.textContent = label;
  }

  function setEditingMode(taskId, options) {
    editingTaskId = taskId || null;
    editingTaskCanDelete =
      !!editingTaskId && (!options || options.canDelete !== false);
    if (editTaskIdInput) editTaskIdInput.value = editingTaskId || "";
    setCreateTabLabel(!!editingTaskId);

    if (submitBtn) {
      var label = editingTaskId ? strings.actionSave : strings.actionCreate;
      if (label) submitBtn.textContent = label;
    }
    if (newTaskBtn) {
      newTaskBtn.style.display = editingTaskId ? "inline-flex" : "none";
    }
    if (editDeleteBtn) {
      editDeleteBtn.style.display = editingTaskCanDelete
        ? "inline-flex"
        : "none";
    }
  }

  // Tab switching function
  function switchTab(tabName) {
    document.querySelectorAll(".tab-button").forEach(function (b) {
      b.classList.remove("active");
    });
    document.querySelectorAll(".tab-content").forEach(function (c) {
      c.classList.remove("active");
    });
    var targetBtn = document.querySelector(
      '.tab-button[data-tab="' + tabName + '"]',
    );
    var targetContent = document.getElementById(tabName + "-tab");
    if (targetBtn) targetBtn.classList.add("active");
    if (targetContent) targetContent.classList.add("active");
    scheduleLayoutRefresh();
  }

  function openCreateTaskForm() {
    clearPendingSubmitState();
    resetForm();
    switchTab("create");
    try {
      var taskNameEl = document.getElementById("task-name");
      if (taskNameEl && typeof taskNameEl.focus === "function") {
        taskNameEl.focus();
      }
    } catch (e) {
      // ignore
    }
  }

  // Keep pending values in sync when the user explicitly changes selection
  if (agentSelect) {
    agentSelect.addEventListener("change", function () {
      pendingAgentValue = "";
    });
  }
  if (modelSelect) {
    modelSelect.addEventListener("change", function () {
      clearUnavailableModelOptions(modelSelect);
      clearPendingModelSelection();
      updateModelVariantOptions(
        findModelPickerGroup(getActiveModelPickerGroups(), modelSelect.value),
        null,
      );
      updateModelSelectionStatus();
      scheduleLayoutRefresh();
    });
  }
  if (modelVariantSelect) {
    modelVariantSelect.addEventListener("change", function () {
      clearPendingModelSelection();
      updateModelSelectionStatus();
      scheduleLayoutRefresh();
    });
  }
  if (templateSelect) {
    templateSelect.addEventListener("change", function () {
      pendingTemplatePath = templateSelect ? templateSelect.value : "";
      setTemplatePromptBaseline(null);
    });
  }

  window.addEventListener("resize", function () {
    scheduleLayoutRefresh();
  });

  // Use event delegation for tab buttons (works even when clicking text/child nodes)
  function resolveTabButton(node) {
    var el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains("tab-button")) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  document.addEventListener("click", function (e) {
    var button = resolveTabButton(e.target);
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    var tabName = button.getAttribute("data-tab");
    if (tabName) {
      switchTab(tabName);
    }
  });

  document.addEventListener("click", function (e) {
    var el =
      e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute("data-open-create") === "true") {
        e.preventDefault();
        openCreateTaskForm();
        return;
      }
      el = el.parentElement;
    }
  });

  // Use event delegation for prompt source radio buttons
  document.addEventListener("change", function (e) {
    var target = e.target;
    if (target && target.name === "prompt-source" && target.checked) {
      applyPromptSource(target.value);
    }
  });

  // Cron preset handling with null check
  if (cronPreset && cronExpression) {
    cronPreset.addEventListener("change", function () {
      if (cronPreset.value) {
        cronExpression.value = cronPreset.value;
      }
      updateCronPreview();
    });

    cronExpression.addEventListener("input", function () {
      cronPreset.value = "";
      updateCronPreview();
    });
  }

  if (friendlyFrequency) {
    friendlyFrequency.addEventListener("change", function () {
      updateFriendlyVisibility();
    });
  }

  // Some environments may miss direct events on the select; keep it in sync via delegation.
  document.addEventListener("change", function (e) {
    var target = e && e.target;
    if (target && target.id === "friendly-frequency") {
      updateFriendlyVisibility();
    }
  });

  document.addEventListener("input", function (e) {
    var target = e && e.target;
    if (target && target.id === "friendly-frequency") {
      updateFriendlyVisibility();
    }
  });

  if (friendlyGenerate) {
    friendlyGenerate.addEventListener("click", function () {
      generateCronFromFriendly();
    });
  }

  if (openGuruBtn) {
    openGuruBtn.addEventListener("click", function () {
      var expression = cronExpression ? cronExpression.value.trim() : "";
      if (!expression) {
        expression = "* * * * *";
      }
      if (splitCronLines(expression).length > 1) {
        showFormError(strings.cronPreviewMultipleExpressions || "", 5000);
        return;
      }
      var targetUrl = "https://crontab.guru/#" + encodeURIComponent(expression);
      window.open(targetUrl, "_blank");
    });
  }

  // Template selection with null check
  if (templateSelect) {
    templateSelect.addEventListener("change", function () {
      var selectedPath = templateSelect.value;
      setTemplatePromptBaseline(null);
      if (selectedPath) {
        var sourceEl = document.querySelector(
          'input[name="prompt-source"]:checked',
        );
        var source = sourceEl ? sourceEl.value : "inline";
        requestTemplateLoad(selectedPath, source);
      } else {
        setTemplatePromptBaseline(null);
        clearTemplateLoading();
      }
    });
  }

  // Form submission with null checks
  if (taskForm) {
    taskForm.addEventListener("submit", function (e) {
      e.preventDefault();

      var formErr = document.getElementById("form-error");
      if (formErr) {
        formErr.style.display = "none";
      }

      var taskNameEl = document.getElementById("task-name");
      var promptTextEl = document.getElementById("prompt-text");
      var scopeEl = document.querySelector('input[name="scope"]:checked');
      var promptSourceEl = document.querySelector(
        'input[name="prompt-source"]:checked',
      );
      var runFirstEl = document.getElementById("run-first");

      var promptSourceValue = promptSourceEl ? promptSourceEl.value : "inline";

      // Preserve values if dropdown options are not loaded yet
      var agentValue = agentSelect ? agentSelect.value : "";
      if (editingTaskId && !agentValue && pendingAgentValue) {
        agentValue = pendingAgentValue;
      }
      var currentModelSelection = getCurrentModelSelection();
      var modelValue = currentModelSelection
        ? currentModelSelection.model || ""
        : "";
      var modelNameValue = currentModelSelection
        ? currentModelSelection.modelName || ""
        : "";
      var modelVendorValue = currentModelSelection
        ? currentModelSelection.modelVendor || ""
        : "";
      var modelFamilyValue = currentModelSelection
        ? currentModelSelection.modelFamily || ""
        : "";
      var modelVersionValue = currentModelSelection
        ? currentModelSelection.modelVersion || ""
        : "";
      var modelReasoningEffortValue = currentModelSelection
        ? currentModelSelection.modelReasoningEffort || ""
        : "";
      if (editingTaskId) {
        if (!modelNameValue && pendingModelName) {
          modelNameValue = pendingModelName;
        }
        if (!modelVendorValue && pendingModelVendor) {
          modelVendorValue = pendingModelVendor;
        }
        if (!modelFamilyValue && pendingModelFamily) {
          modelFamilyValue = pendingModelFamily;
        }
        if (!modelVersionValue && pendingModelVersion) {
          modelVersionValue = pendingModelVersion;
        }
        if (!modelReasoningEffortValue && pendingModelReasoningEffort) {
          modelReasoningEffortValue = pendingModelReasoningEffort;
        }
      }
      var promptPathValue = templateSelect ? templateSelect.value : "";
      if (
        promptSourceValue !== "inline" &&
        editingTaskId &&
        !promptPathValue &&
        pendingTemplatePath
      ) {
        promptPathValue = pendingTemplatePath;
      }

      var isAllowedTimeWindowEnabled = allowedTimeEnabledInput
        ? allowedTimeEnabledInput.checked
        : !!(
            (allowedTimeStartInput && allowedTimeStartInput.value) ||
            (allowedTimeEndInput && allowedTimeEndInput.value)
          );

      var taskData = {
        name: taskNameEl ? taskNameEl.value : "",
        prompt: promptTextEl ? promptTextEl.value : "",
        cronExpression: cronExpression ? cronExpression.value : "",
        agent: agentValue,
        model: modelValue,
        modelName: modelNameValue,
        modelVendor: modelVendorValue,
        modelFamily: modelFamilyValue,
        modelVersion: modelVersionValue,
        modelReasoningEffort: modelReasoningEffortValue,
        scope: scopeEl ? scopeEl.value : "workspace",
        promptSource: promptSourceValue,
        promptPath: promptPathValue,
        runFirstInOneMinute: runFirstEl ? runFirstEl.checked : false,
        autoMode: autoModeInput ? autoModeInput.checked : false,
        chatSession: chatSessionSelect ? chatSessionSelect.value : "default",
        jitterSeconds: jitterSecondsInput
          ? boundedNumber(jitterSecondsInput.value || 0, 0, 1800, 0)
          : 0,
        maxExecutionsPerDay: maxExecutionsPerDayInput
          ? boundedNumber(maxExecutionsPerDayInput.value || 0, 0, 100, 0)
          : 0,
        allowedTimeStart:
          isAllowedTimeWindowEnabled && allowedTimeStartInput
            ? String(allowedTimeStartInput.value || "").trim()
            : "",
        allowedTimeEnd:
          isAllowedTimeWindowEnabled && allowedTimeEndInput
            ? String(allowedTimeEndInput.value || "").trim()
            : "",
        enabled: editingTaskId ? editingTaskEnabled : true,
      };

      var nameValue = (taskData.name || "").trim();
      if (!nameValue) {
        if (formErr) {
          formErr.textContent = strings.taskNameRequired || "";
          formErr.style.display = "block";
        }
        return;
      }

      var templateValue = (taskData.promptPath || "").trim();
      if (promptSourceValue !== "inline" && !templateValue) {
        if (formErr) {
          formErr.textContent = strings.templateRequired || "";
          formErr.style.display = "block";
        }
        return;
      }

      if (
        promptSourceValue !== "inline" &&
        templateValue &&
        templateLoadingPath === templateValue
      ) {
        if (formErr) {
          formErr.textContent =
            strings.templateLoadingInProgress ||
            strings.templateLoadError ||
            "";
          formErr.style.display = "block";
        }
        return;
      }

      if (promptSourceValue !== "inline" && templatePromptBaseline === null) {
        if (formErr) {
          formErr.textContent = templateLoadingPath
            ? strings.templateLoadingInProgress ||
              strings.templateLoadError ||
              ""
            : strings.templateLoadError ||
              strings.templateLoadingInProgress ||
              "";
          formErr.style.display = "block";
        }
        return;
      }

      var promptValue = (taskData.prompt || "").trim();
      if (!promptValue) {
        if (formErr) {
          formErr.textContent = strings.promptRequired || "";
          formErr.style.display = "block";
        }
        return;
      }

      if (
        promptSourceValue !== "inline" &&
        templatePromptBaseline !== null &&
        taskData.prompt !== templatePromptBaseline
      ) {
        taskData.promptSource = "inline";
        taskData.promptPath = "";
      }

      var cronValue = (taskData.cronExpression || "").trim();
      if (!cronValue) {
        if (formErr) {
          formErr.textContent =
            strings.cronExpressionRequired ||
            strings.invalidCronExpression ||
            "";
          formErr.style.display = "block";
        }
        return;
      }

      var isValidHHmm = function (value) {
        if (!value) return true;
        var m = /^(\d{2}):(\d{2})$/.exec(String(value));
        if (!m) return false;
        var hh = Number(m[1]);
        var mm = Number(m[2]);
        return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
      };
      if (
        taskData.allowedTimeStart &&
        !isValidHHmm(taskData.allowedTimeStart)
      ) {
        if (formErr) {
          formErr.textContent = strings.invalidTimeWindowFormat || "";
          formErr.style.display = "block";
        }
        return;
      }
      if (taskData.allowedTimeEnd && !isValidHHmm(taskData.allowedTimeEnd)) {
        if (formErr) {
          formErr.textContent = strings.invalidTimeWindowFormat || "";
          formErr.style.display = "block";
        }
        return;
      }

      pendingSubmit = true;
      if (submitBtn) submitBtn.disabled = true;

      if (editingTaskId) {
        vscode.postMessage({
          type: "updateTask",
          taskId: editingTaskId,
          data: taskData,
        });
      } else {
        vscode.postMessage({
          type: "createTask",
          data: taskData,
        });
      }
    });
  }

  // Test button with null check
  if (testBtn) {
    testBtn.addEventListener("click", function () {
      var promptTextEl = document.getElementById("prompt-text");
      var prompt = promptTextEl ? promptTextEl.value : "";
      var agent = agentSelect ? agentSelect.value : "";
      var currentModelSelection = getCurrentModelSelection();
      var model = currentModelSelection
        ? currentModelSelection.model || ""
        : "";
      var normalizedPrompt = typeof prompt === "string" ? prompt.trim() : "";

      if (!normalizedPrompt) {
        showFormError(strings.promptRequired || "", 5000);
        return;
      }

      vscode.postMessage({
        type: "testPrompt",
        prompt: prompt,
        agent: agent,
        chatSession:
          chatSessionSelect &&
          (chatSessionSelect.value === "new" ||
            chatSessionSelect.value === "continue")
            ? chatSessionSelect.value
            : undefined,
        model: model,
        modelName: currentModelSelection
          ? currentModelSelection.modelName || ""
          : "",
        modelVendor: currentModelSelection
          ? currentModelSelection.modelVendor || ""
          : "",
        modelFamily: currentModelSelection
          ? currentModelSelection.modelFamily || ""
          : "",
        modelVersion: currentModelSelection
          ? currentModelSelection.modelVersion || ""
          : "",
        modelReasoningEffort: currentModelSelection
          ? currentModelSelection.modelReasoningEffort || ""
          : "",
      });
    });
  }

  // Refresh button with null check
  if (refreshBtn) {
    refreshBtn.addEventListener("click", function () {
      vscode.postMessage({ type: "refreshAgents" });
      vscode.postMessage({ type: "refreshPrompts" });
    });
  }

  // Template refresh button (Create tab)
  if (templateRefreshBtn) {
    templateRefreshBtn.addEventListener("click", function () {
      vscode.postMessage({ type: "refreshPrompts" });

      // If a template is currently selected, re-load its content as well.
      var selectedPath = templateSelect ? templateSelect.value : "";
      var sourceEl = document.querySelector(
        'input[name="prompt-source"]:checked',
      );
      var source = sourceEl ? sourceEl.value : "inline";
      if (selectedPath && (source === "local" || source === "global")) {
        requestTemplateLoad(selectedPath, source);
      }
    });
  }

  // Task action delegation (single listener)
  function resolveActionTarget(node) {
    var el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== document.body) {
      if (
        el.hasAttribute &&
        el.hasAttribute("data-action") &&
        el.hasAttribute("data-id")
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  document.addEventListener("click", function (e) {
    var actionTarget = resolveActionTarget(e.target);
    if (!actionTarget) {
      return;
    }

    if (!taskList || !taskList.isConnected) {
      taskList = document.getElementById("task-list");
    }
    if (taskList && !taskList.contains(actionTarget)) {
      return;
    }

    var action = actionTarget.getAttribute("data-action");
    var taskId = actionTarget.getAttribute("data-id");
    if (!action || !taskId) {
      return;
    }

    var actionHandlers = {
      toggle: window.toggleTask,
      run: window.runTask,
      edit: window.editTask,
      copy: window.copyPrompt,
      duplicate: window.duplicateTask,
      move: window.moveTaskToCurrentWorkspace,
      delete: window.deleteTask,
    };

    var handler = actionHandlers[action];
    if (typeof handler === "function") {
      e.preventDefault();
      handler(taskId);
    }
  });

  // Render task list
  function renderTaskList(nextTasks) {
    if (Array.isArray(nextTasks)) {
      tasks = nextTasks.filter(Boolean);
    }

    if (!taskList || !taskList.isConnected) {
      taskList = document.getElementById("task-list");
    }

    var taskItems = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
    var enabledCount = taskItems.filter(function (task) {
      return task && task.enabled;
    }).length;
    if (summaryTotal) {
      summaryTotal.textContent = String(taskItems.length);
    }
    if (summaryEnabled) {
      summaryEnabled.textContent = String(enabledCount);
    }
    if (summaryPaused) {
      summaryPaused.textContent = String(taskItems.length - enabledCount);
    }
    if (!taskList) return;

    var renderedTasks = "";

    function captureTaskGroupOpenState() {
      if (!taskList || typeof taskList.querySelectorAll !== "function") {
        return;
      }
      var groups = taskList.querySelectorAll(
        "details.task-group-collapsible[data-group]",
      );
      if (!groups || typeof groups.length !== "number") {
        return;
      }
      for (var i = 0; i < groups.length; i++) {
        var group = groups[i];
        if (!group || !group.getAttribute) {
          continue;
        }
        var key = group.getAttribute("data-group");
        if (!key) {
          continue;
        }
        taskGroupOpenState[key] = !!group.open;
      }
    }

    captureTaskGroupOpenState();

    function basename(p) {
      if (!p) return "";
      var s = String(p).replace(/[/\\]+$/, "");
      var parts = s.split(/[/\\]+/);
      return parts.length ? parts[parts.length - 1] || "" : s;
    }

    function buildEmptyState() {
      return (
        '<div class="surface empty-state">' +
        '<div class="empty-state-title">' +
        escapeHtml(strings.noTasksFound || "") +
        "</div>" +
        '<p class="empty-state-description">' +
        escapeHtml(strings.emptyStateDescription || "") +
        "</p>" +
        '<button type="button" class="btn-primary" data-open-create="true">' +
        escapeHtml(strings.actionNewTask || "") +
        "</button>" +
        "</div>"
      );
    }

    function getPromptSourceLabel(task) {
      var promptSourceValue =
        task && task.promptSource ? task.promptSource : "inline";
      if (promptSourceValue === "local") {
        return strings.labelPromptLocal || "";
      }
      if (promptSourceValue === "global") {
        return strings.labelPromptGlobal || "";
      }
      return strings.labelPromptInline || "";
    }

    function getTaskChatSessionLabel(task) {
      if (!task || !task.chatSession) return "";
      if (task.chatSession === "continue") {
        return strings.labelChatSessionContinue || "";
      }
      return strings.labelChatSessionNew || "";
    }

    function buildSection(title, count, content) {
      return (
        '<section class="task-section">' +
        '<div class="task-section-header">' +
        '<h2 class="task-section-title">' +
        escapeHtml(title) +
        "</h2>" +
        '<span class="task-section-count">' +
        escapeHtml(String(count)) +
        "</span>" +
        "</div>" +
        '<div class="task-group-inner">' +
        content.join("") +
        "</div>" +
        "</section>"
      );
    }

    function buildTaskCard(task) {
      if (!task || !task.id) {
        return null;
      }

      var enabled = task.enabled || false;
      var statusClass = enabled ? "enabled" : "disabled";
      var statusText = enabled ? strings.labelEnabled : strings.labelDisabled;
      var toggleTitle = enabled ? strings.actionDisable : strings.actionEnable;
      var nextRunDate = task.nextRun ? new Date(task.nextRun) : null;
      var nextRun =
        nextRunDate && !isNaN(nextRunDate.getTime())
          ? nextRunDate.toLocaleString(locale)
          : strings.labelNever;
      var lastRunDate = task.lastRun ? new Date(task.lastRun) : null;
      var lastRun =
        lastRunDate && !isNaN(lastRunDate.getTime())
          ? lastRunDate.toLocaleString(locale)
          : strings.labelNever;
      var promptText = typeof task.prompt === "string" ? task.prompt : "";
      var promptPreview =
        promptText.length > 180
          ? promptText.substring(0, 180) + "..."
          : promptText;
      var cronSummary =
        task.scheduleSummary || getCronSummary(task.cronExpression || "");
      var cronText = escapeHtml(
        cronSummary || strings.labelFriendlyFallback || "",
      );
      var cronRaw = escapeAttr(task.cronExpression || "");
      var taskName = escapeHtml(task.name || "");
      var promptSourceLabel = getPromptSourceLabel(task);

      var scopeValue = task.scope || "workspace";
      var scopeLabel =
        scopeValue === "global"
          ? strings.labelScopeGlobal || ""
          : strings.labelScopeWorkspace || "";
      var wsPath = scopeValue === "workspace" ? task.workspacePath || "" : "";
      var wsName = wsPath ? basename(wsPath) : "";
      var inThisWorkspace =
        scopeValue === "global" ? true : isTaskInCurrentWorkspace(task);
      var section = "global";
      if (scopeValue === "workspace") {
        section = inThisWorkspace ? "this-workspace" : "other-workspace";
      }

      var otherWsLabel = strings.labelOtherWorkspaceShort || "";
      var thisWsLabel = strings.labelThisWorkspaceShort || "";
      var scopeInfo =
        scopeValue === "global"
          ? escapeHtml(scopeLabel)
          : escapeHtml(scopeLabel) + (wsName ? " • " + escapeHtml(wsName) : "");
      if (scopeValue === "workspace") {
        scopeInfo +=
          " • " + escapeHtml(inThisWorkspace ? thisWsLabel : otherWsLabel);
      }

      var taskDailyLimit = Number(task.maxExecutionsPerDay || 0);
      var hasTaskDailyLimit = isFinite(taskDailyLimit) && taskDailyLimit > 0;
      var taskChatSessionLabel = getTaskChatSessionLabel(task);
      var timeStart = task.allowedTimeStart || "";
      var timeEnd = task.allowedTimeEnd || "";
      var timeWindowInfo =
        timeStart || timeEnd
          ? escapeHtml(strings.labelAllowedTimeWindow || "") +
            ": " +
            escapeHtml((timeStart || "--:--") + " - " + (timeEnd || "--:--"))
          : "";

      var taskIdEscaped = escapeAttr(task.id || "");

      var actionsHtml =
        '<button type="button" class="btn-primary action-chip" data-action="run" data-id="' +
        taskIdEscaped +
        '" title="' +
        escapeAttr(strings.actionRun) +
        '">' +
        escapeHtml(strings.actionRun) +
        "</button>" +
        '<button type="button" class="btn-secondary action-chip" data-action="edit" data-id="' +
        taskIdEscaped +
        '" title="' +
        escapeAttr(strings.actionEdit) +
        '">' +
        escapeHtml(strings.actionEdit) +
        "</button>" +
        '<button type="button" class="btn-secondary action-chip" data-action="toggle" data-id="' +
        taskIdEscaped +
        '" title="' +
        escapeAttr(toggleTitle) +
        '">' +
        escapeHtml(toggleTitle) +
        "</button>" +
        '<button type="button" class="btn-secondary action-chip" data-action="copy" data-id="' +
        taskIdEscaped +
        '" title="' +
        escapeAttr(strings.actionCopyPrompt) +
        '">' +
        escapeHtml(strings.actionCopyPrompt) +
        "</button>" +
        '<button type="button" class="btn-secondary action-chip" data-action="duplicate" data-id="' +
        taskIdEscaped +
        '" title="' +
        escapeAttr(strings.actionDuplicate) +
        '">' +
        escapeHtml(strings.actionDuplicate) +
        "</button>";

      if (scopeValue === "workspace" && !inThisWorkspace) {
        actionsHtml +=
          '<button type="button" class="btn-secondary action-chip" data-action="move" data-id="' +
          taskIdEscaped +
          '" title="' +
          escapeAttr(strings.actionMoveToCurrentWorkspace || "") +
          '">' +
          escapeHtml(strings.actionMoveToCurrentWorkspace || "") +
          "</button>";
      }

      if (scopeValue === "global" || inThisWorkspace) {
        actionsHtml +=
          '<button type="button" class="btn-danger action-chip" data-action="delete" data-id="' +
          taskIdEscaped +
          '" title="' +
          escapeAttr(strings.actionDelete) +
          '">' +
          escapeHtml(strings.actionDelete) +
          "</button>";
      }

      var metaHtml =
        '<span title="' +
        cronRaw +
        '">⏰ ' +
        cronText +
        "</span>" +
        (taskChatSessionLabel
          ? "<span>" +
            escapeHtml(strings.labelChatSession || "") +
            ": " +
            escapeHtml(taskChatSessionLabel) +
            "</span>"
          : "") +
        "<span>" +
        escapeHtml(strings.labelLastRun) +
        ": " +
        escapeHtml(lastRun) +
        "</span>" +
        "<span>" +
        escapeHtml(strings.labelPromptType) +
        ": " +
        escapeHtml(promptSourceLabel) +
        "</span>" +
        (hasTaskDailyLimit
          ? "<span>" +
            escapeHtml(strings.labelMaxExecutionsPerDay || "") +
            ": " +
            escapeHtml(String(taskDailyLimit)) +
            "</span>"
          : "") +
        (timeWindowInfo ? "<span>" + timeWindowInfo + "</span>" : "") +
        "<span>" +
        scopeInfo +
        "</span>";

      var html =
        '<div class="task-card ' +
        (enabled ? "" : "disabled") +
        (scopeValue === "workspace" && !inThisWorkspace
          ? " other-workspace"
          : "") +
        '" data-id="' +
        taskIdEscaped +
        '">' +
        '<div class="task-header">' +
        '<div class="task-header-main">' +
        '<button type="button" class="task-title-button task-name" data-action="edit" data-id="' +
        taskIdEscaped +
        '">' +
        taskName +
        "</button>" +
        '<div class="task-status-row">' +
        '<span class="task-status ' +
        statusClass +
        '">' +
        escapeHtml(statusText) +
        "</span>" +
        '<span class="scope-badge">' +
        escapeHtml(scopeLabel) +
        "</span>" +
        "</div>" +
        "</div>" +
        '<div class="task-next-run">' +
        '<span class="task-next-run-label">' +
        escapeHtml(strings.labelNextRun) +
        "</span>" +
        "<strong>" +
        escapeHtml(nextRun) +
        "</strong>" +
        "</div>" +
        "</div>" +
        '<div class="task-info">' +
        metaHtml +
        "</div>" +
        '<div class="task-prompt">' +
        escapeHtml(promptPreview) +
        "</div>" +
        '<div class="task-actions">' +
        actionsHtml +
        "</div>" +
        "</div>";

      return {
        html: html,
        section: section,
      };
    }

    if (taskItems.length === 0) {
      renderedTasks = buildEmptyState();
    } else {
      var thisWorkspaceCards = [];
      var globalCards = [];
      var otherWorkspaceCards = [];

      taskItems.forEach(function (task) {
        var card = buildTaskCard(task);
        if (!card || !card.html) {
          return;
        }
        if (card.section === "this-workspace") {
          thisWorkspaceCards.push(card.html);
          return;
        }
        if (card.section === "other-workspace") {
          otherWorkspaceCards.push(card.html);
          return;
        }
        globalCards.push(card.html);
      });

      if (thisWorkspaceCards.length > 0) {
        renderedTasks += buildSection(
          strings.labelThisWorkspaceShort || strings.labelScopeWorkspace || "",
          thisWorkspaceCards.length,
          thisWorkspaceCards,
        );
      }

      if (globalCards.length > 0) {
        var globalSectionLabel = strings.labelScopeGlobal || "";
        var globalSummaryText = globalSectionLabel
          ? globalSectionLabel + " (" + String(globalCards.length) + ")"
          : String(globalCards.length);
        var isGlobalGroupOpen = taskGroupOpenState.global !== false;

        renderedTasks +=
          '<details class="task-group-collapsible" data-group="global"' +
          (isGlobalGroupOpen ? " open" : "") +
          ">" +
          "<summary>" +
          escapeHtml(globalSummaryText) +
          "</summary>" +
          '<div class="task-group-inner">' +
          globalCards.join("") +
          "</div>" +
          "</details>";
      }

      if (otherWorkspaceCards.length > 0) {
        var otherWorkspaceSectionLabel = strings.labelOtherWorkspaceShort || "";
        var summaryText = otherWorkspaceSectionLabel
          ? otherWorkspaceSectionLabel +
            " (" +
            String(otherWorkspaceCards.length) +
            ")"
          : String(otherWorkspaceCards.length);
        var isOtherWorkspaceGroupOpen =
          !!taskGroupOpenState["other-workspaces"];

        renderedTasks +=
          '<details class="task-group-collapsible" data-group="other-workspaces"' +
          (isOtherWorkspaceGroupOpen ? " open" : "") +
          ">" +
          "<summary>" +
          escapeHtml(summaryText) +
          "</summary>" +
          '<div class="task-group-inner">' +
          otherWorkspaceCards.join("") +
          "</div>" +
          "</details>";
      }

      if (!renderedTasks) {
        renderedTasks = buildEmptyState();
      }
    }

    if (renderedTasks === lastRenderedTasksHtml) {
      return;
    }

    lastRenderedTasksHtml = renderedTasks;
    taskList.innerHTML = renderedTasks;
  }

  // Helper functions
  function escapeHtml(text) {
    if (text == null) return "";
    var div = document.createElement("div");
    div.textContent = String(text);
    return div.innerHTML;
  }

  function escapeAttr(text) {
    if (typeof text !== "string") text = String(text || "");
    return text
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  var dayNames = [
    strings.daySun || "",
    strings.dayMon || "",
    strings.dayTue || "",
    strings.dayWed || "",
    strings.dayThu || "",
    strings.dayFri || "",
    strings.daySat || "",
  ];

  function padNumber(value) {
    var num = parseInt(String(value), 10);
    if (isNaN(num)) num = 0;
    return num < 10 ? "0" + num : String(num);
  }

  function boundedNumber(value, min, max, fallback) {
    var num = parseInt(String(value), 10);
    if (isNaN(num)) {
      num = fallback;
    }
    num = Math.max(min, Math.min(max, num));
    return num;
  }

  function normalizeDow(value) {
    var normalized = String(value || "")
      .trim()
      .toLowerCase();
    if (/^\d+$/.test(normalized)) {
      var asNumber = parseInt(normalized, 10);
      if (asNumber === 7) asNumber = 0;
      if (asNumber >= 0 && asNumber <= 6) return asNumber;
    }

    var map = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    };

    if (map.hasOwnProperty(normalized)) {
      return map[normalized];
    }

    return null;
  }

  function formatTime(hour, minute) {
    return padNumber(hour) + ":" + padNumber(minute);
  }

  function splitCronLines(expression) {
    return String(expression || "")
      .split(/\r?\n/)
      .map(function (line) {
        return line.trim();
      })
      .filter(Boolean);
  }

  function normalizeCronExpressionForCompare(expression) {
    return splitCronLines(expression).join("\n");
  }

  function formatIntervalLabel(totalMinutes) {
    if (totalMinutes % 60 === 0) {
      if (totalMinutes === 60) return strings.cronPreviewEveryHour || "";
      var tplHours = strings.cronPreviewEveryNHours || "";
      return tplHours ? tplHours.replace("{n}", String(totalMinutes / 60)) : "";
    }
    var tplMinutes = strings.cronPreviewEveryNMinutes || "";
    return tplMinutes ? tplMinutes.replace("{n}", String(totalMinutes)) : "";
  }

  function buildStrictIntervalCron(totalMinutes) {
    var minutes = Number(totalMinutes);
    if (!Number.isFinite(minutes) || Math.floor(minutes) !== minutes) return "";
    if (minutes <= 0 || minutes > 1440) return "";

    if (minutes < 60 && 60 % minutes === 0) {
      return "*/" + minutes + " * * * *";
    }
    if (minutes === 60) {
      return "0 * * * *";
    }
    if (minutes % 60 === 0) {
      var hours = minutes / 60;
      if (24 % hours === 0) {
        return "0 */" + hours + " * * *";
      }
    }
    if (1440 % minutes !== 0) {
      return "";
    }

    var minutesToHours = Object.create(null);
    for (var minuteOfDay = 0; minuteOfDay < 1440; minuteOfDay += minutes) {
      var hour = Math.floor(minuteOfDay / 60);
      var minute = minuteOfDay % 60;
      if (!minutesToHours[minute]) {
        minutesToHours[minute] = [];
      }
      minutesToHours[minute].push(hour);
    }

    var groups = [];
    var groupByHours = Object.create(null);
    var minuteKeys = Object.keys(minutesToHours).sort(function (a, b) {
      return Number(a) - Number(b);
    });
    for (var keyIndex = 0; keyIndex < minuteKeys.length; keyIndex++) {
      var minuteKey = minuteKeys[keyIndex];
      var hoursForMinute = minutesToHours[minuteKey];
      var key = hoursForMinute.join(",");
      if (!groupByHours[key]) {
        groupByHours[key] = { minutes: [], hours: hoursForMinute };
        groups.push(groupByHours[key]);
      }
      var minuteNumber = Number(minuteKey);
      if (groupByHours[key].minutes.indexOf(minuteNumber) === -1) {
        groupByHours[key].minutes.push(minuteNumber);
      }
    }

    return groups
      .map(function (group) {
        return group.minutes.join(",") + " " + group.hours.join(",") + " * * *";
      })
      .join("\n");
  }

  function getStrictIntervalSummary(expression) {
    var normalized = normalizeCronExpressionForCompare(expression);
    for (var i = 0; i < friendlyIntervalMinutes.length; i++) {
      var minutes = friendlyIntervalMinutes[i];
      if (
        normalizeCronExpressionForCompare(buildStrictIntervalCron(minutes)) ===
        normalized
      ) {
        return formatIntervalLabel(minutes);
      }
    }
    return "";
  }

  function getCronSummary(expression) {
    var fallback = strings.labelFriendlyFallback || "";
    var expr = (expression || "").trim();
    if (!expr) return fallback;

    var strictIntervalSummary = getStrictIntervalSummary(expr);
    if (strictIntervalSummary) return strictIntervalSummary;

    var lines = splitCronLines(expr);
    if (lines.length > 1) {
      return strings.cronPreviewMultipleExpressions || fallback;
    }

    var parts = expr.split(/\s+/);
    if (parts.length !== 5) {
      return fallback;
    }

    var minute = parts[0];
    var hour = parts[1];
    var dom = parts[2];
    var mon = parts[3];
    var dow = parts[4];

    var isNumber = function (value) {
      return /^\d+$/.test(String(value));
    };
    var dowLower = String(dow || "").toLowerCase();
    var isWeekdays = dowLower === "1-5" || dowLower === "mon-fri";
    var everyN = /^\*\/(\d+)$/.exec(minute);

    if (everyN && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
      var tplEveryN = strings.cronPreviewEveryNMinutes || "";
      return tplEveryN ? tplEveryN.replace("{n}", String(everyN[1])) : fallback;
    }

    if (
      isNumber(minute) &&
      hour === "*" &&
      dom === "*" &&
      mon === "*" &&
      dow === "*"
    ) {
      var tplHourly = strings.cronPreviewHourlyAtMinute || "";
      return tplHourly ? tplHourly.replace("{m}", String(minute)) : fallback;
    }

    if (
      isNumber(minute) &&
      isNumber(hour) &&
      dom === "*" &&
      mon === "*" &&
      dow === "*"
    ) {
      var tplDaily = strings.cronPreviewDailyAt || "";
      var t = formatTime(hour, minute);
      return tplDaily ? tplDaily.replace("{t}", String(t)) : fallback;
    }

    if (
      isNumber(minute) &&
      isNumber(hour) &&
      dom === "*" &&
      mon === "*" &&
      isWeekdays
    ) {
      var tplWeekdays = strings.cronPreviewWeekdaysAt || "";
      var t = formatTime(hour, minute);
      return tplWeekdays ? tplWeekdays.replace("{t}", String(t)) : fallback;
    }

    var dowValue = normalizeDow(dow);
    if (
      isNumber(minute) &&
      isNumber(hour) &&
      dom === "*" &&
      mon === "*" &&
      dowValue !== null
    ) {
      var dayLabel = dayNames[dowValue] || String(dowValue);
      var tplWeekly = strings.cronPreviewWeeklyOnAt || "";
      var t = formatTime(hour, minute);
      return tplWeekly
        ? tplWeekly.replace("{d}", String(dayLabel)).replace("{t}", String(t))
        : fallback;
    }

    if (
      isNumber(minute) &&
      isNumber(hour) &&
      isNumber(dom) &&
      mon === "*" &&
      dow === "*"
    ) {
      var tplMonthly = strings.cronPreviewMonthlyOnAt || "";
      var t = formatTime(hour, minute);
      return tplMonthly
        ? tplMonthly.replace("{dom}", String(dom)).replace("{t}", String(t))
        : fallback;
    }

    return fallback;
  }

  function updateCronPreview() {
    if (!cronPreviewText || !cronExpression) return;
    var expression = cronExpression.value || "";
    cronPreviewText.textContent = getCronSummary(expression);
    if (openGuruBtn) {
      var hasMultipleLines = splitCronLines(expression).length > 1;
      openGuruBtn.disabled = hasMultipleLines;
      openGuruBtn.title = hasMultipleLines
        ? strings.cronPreviewMultipleExpressions || ""
        : strings.labelOpenInGuru || "";
    }
  }

  function updateFriendlyVisibility() {
    var selection = friendlyFrequency ? friendlyFrequency.value : "";
    var fields = [];
    switch (selection) {
      case "every-n":
        fields = ["interval"];
        break;
      case "hourly":
        fields = ["minute"];
        break;
      case "daily":
        fields = ["hour", "minute"];
        break;
      case "weekly":
        fields = ["dow", "hour", "minute"];
        break;
      case "monthly":
        fields = ["dom", "hour", "minute"];
        break;
      default:
        fields = [];
    }

    var friendlyFields = document.querySelectorAll(".friendly-field");
    for (var i = 0; i < friendlyFields.length; i++) {
      var el = friendlyFields[i];
      if (!el || !el.getAttribute) continue;
      var fieldName = el.getAttribute("data-field");
      if (fields.indexOf(fieldName) !== -1) {
        if (el.classList) el.classList.add("visible");
        if (el.style) el.style.display = "block";
      } else {
        if (el.classList) el.classList.remove("visible");
        if (el.style) el.style.display = "none";
      }
    }
  }

  function generateCronFromFriendly() {
    if (!friendlyFrequency || !cronExpression) return;
    var selection = friendlyFrequency.value;
    var expr = "";

    switch (selection) {
      case "every-n": {
        var interval = boundedNumber(
          friendlyInterval ? friendlyInterval.value : "",
          1,
          1440,
          20,
        );
        expr = buildStrictIntervalCron(interval);
        if (!expr) {
          showFormError(strings.labelUnsupportedInterval || "", 5000);
          return;
        }
        break;
      }
      case "hourly": {
        var minuteValue = boundedNumber(
          friendlyMinute ? friendlyMinute.value : "",
          0,
          59,
          0,
        );
        expr = minuteValue + " * * * *";
        break;
      }
      case "daily": {
        var dailyMinute = boundedNumber(
          friendlyMinute ? friendlyMinute.value : "",
          0,
          59,
          0,
        );
        var dailyHour = boundedNumber(
          friendlyHour ? friendlyHour.value : "",
          0,
          23,
          9,
        );
        expr = dailyMinute + " " + dailyHour + " * * *";
        break;
      }
      case "weekly": {
        var weeklyMinute = boundedNumber(
          friendlyMinute ? friendlyMinute.value : "",
          0,
          59,
          0,
        );
        var weeklyHour = boundedNumber(
          friendlyHour ? friendlyHour.value : "",
          0,
          23,
          9,
        );
        var dowValue = boundedNumber(
          friendlyDow ? friendlyDow.value : "",
          0,
          6,
          1,
        );
        expr = weeklyMinute + " " + weeklyHour + " * * " + dowValue;
        break;
      }
      case "monthly": {
        var monthlyMinute = boundedNumber(
          friendlyMinute ? friendlyMinute.value : "",
          0,
          59,
          0,
        );
        var monthlyHour = boundedNumber(
          friendlyHour ? friendlyHour.value : "",
          0,
          23,
          9,
        );
        var domValue = boundedNumber(
          friendlyDom ? friendlyDom.value : "",
          1,
          28,
          1,
        );
        expr = monthlyMinute + " " + monthlyHour + " " + domValue + " * *";
        break;
      }
      default:
        expr = "";
    }

    if (expr) {
      cronExpression.value = expr;
      if (cronPreset) cronPreset.value = "";
      updateCronPreview();
    }
  }

  function resetForm() {
    if (taskForm) taskForm.reset();
    setEditingMode(null);
    setTemplatePromptBaseline(null);
    clearTemplateLoading();
    pendingAgentValue = "";
    clearPendingModelSelection();
    pendingTemplatePath = "";
    editingTaskEnabled = true;
    clearUnavailableModelOptions(modelSelect);
    clearModelVariantOptions();
    updateModelOptions(null);
    updateModelSelectionStatus();
    applyPromptSource("inline");
    if (friendlyFrequency) friendlyFrequency.value = "";
    if (jitterSecondsInput)
      jitterSecondsInput.value = String(defaultJitterSeconds);
    if (maxExecutionsPerDayInput) {
      maxExecutionsPerDayInput.value = "0";
    }
    if (allowedTimeStartInput) {
      allowedTimeStartInput.value = "";
    }
    if (allowedTimeEndInput) {
      allowedTimeEndInput.value = "";
    }
    setAllowedTimeWindowEnabled(false, false);
    if (autoModeInput) autoModeInput.checked = defaultAutoMode;
    if (chatSessionSelect) {
      chatSessionSelect.value = "default";
    }
    var defaultScopeInput = document.querySelector(
      'input[name="scope"][value="' + defaultScope + '"]',
    );
    if (defaultScopeInput) {
      defaultScopeInput.checked = true;
    }
    updateChatSessionDefaultNote();
    updateFriendlyVisibility();
    updateCronPreview();
  }

  function applyUpdatedDefaultsToCreateForm() {
    updateChatSessionDefaultNote();

    if (editingTaskId) {
      return;
    }

    if (autoModeInput) autoModeInput.checked = defaultAutoMode;
    if (jitterSecondsInput) {
      jitterSecondsInput.value = String(defaultJitterSeconds);
    }

    var defaultScopeInput = document.querySelector(
      'input[name="scope"][value="' + defaultScope + '"]',
    );
    if (defaultScopeInput) {
      defaultScopeInput.checked = true;
    }
  }

  function updateAgentOptions() {
    if (!agentSelect) return;
    var items = Array.isArray(agents) ? agents : [];
    if (items.length === 0) {
      var noText = strings.placeholderNoAgents || "";
      agentSelect.innerHTML =
        '<option value="">' + escapeHtml(noText) + "</option>";
    } else {
      var selectText = strings.placeholderSelectAgent || "";
      var placeholder =
        '<option value="">' + escapeHtml(selectText) + "</option>";
      agentSelect.innerHTML =
        placeholder +
        items
          .map(function (a) {
            return (
              '<option value="' +
              escapeAttr(a.id) +
              '">' +
              escapeHtml(a.name) +
              "</option>"
            );
          })
          .join("");
    }
  }

  function updateTemplateOptions(source, selectedPath) {
    if (!templateSelect) return;
    selectedPath = selectedPath || "";
    var templates = Array.isArray(promptTemplates) ? promptTemplates : [];
    var filtered = templates.filter(function (t) {
      return t.source === source;
    });
    var selectText = strings.placeholderSelectTemplate || "";
    var placeholder =
      '<option value="">' + escapeHtml(selectText) + "</option>";
    templateSelect.innerHTML =
      placeholder +
      filtered
        .map(function (t) {
          var displayName = t.displayName || t.name || "";
          return (
            '<option value="' +
            escapeAttr(t.path) +
            '">' +
            escapeHtml(displayName) +
            "</option>"
          );
        })
        .join("");

    if (!selectedPath) {
      templateSelect.value = "";
      return;
    }

    templateSelect.value = selectedPath;
    if (templateSelect.value !== selectedPath) {
      templateSelect.value = "";
    }
  }

  function applyPromptSource(source, keepSelection) {
    var effectiveSource = source || "inline";
    var selectedPath =
      keepSelection && templateSelect ? templateSelect.value : "";

    if (effectiveSource === "inline") {
      setTemplatePromptBaseline(null);
      clearTemplateLoading();
      if (templateSelectGroup) templateSelectGroup.style.display = "none";
      if (promptGroup) promptGroup.style.display = "block";
      if (!keepSelection && templateSelect) {
        templateSelect.value = "";
      }
      return;
    }

    if (templateSelectGroup) {
      templateSelectGroup.style.display = "block";
    } else {
      console.warn(
        "[CopilotScheduler] Template select group missing; template selection is disabled.",
      );
    }
    if (promptGroup) promptGroup.style.display = "block";
    updateTemplateOptions(effectiveSource, selectedPath);
    if (!selectedPath) {
      setTemplatePromptBaseline(null);
      clearTemplateLoading();
    }
  }

  // Initialize dropdowns with cached data
  updateAgentOptions();
  updateModelOptions(null);
  updateModelExperimentalNote();
  var initialPromptSource = document.querySelector(
    'input[name="prompt-source"]:checked',
  );
  if (initialPromptSource) {
    applyPromptSource(initialPromptSource.value);
  }
  updateChatSessionDefaultNote();
  updateFriendlyVisibility();
  updateCronPreview();

  // Global functions for onclick handlers
  window.runTask = function (id) {
    vscode.postMessage({ type: "runTask", taskId: id });
  };

  function selectHasOptionValue(selectEl, value) {
    if (!selectEl || !value) return false;
    var opts = selectEl.options;
    if (!opts || typeof opts.length !== "number") return false;
    for (var i = 0; i < opts.length; i++) {
      var opt = opts[i];
      if (opt && opt.value === value) return true;
    }
    return false;
  }

  window.editTask = function (id) {
    var taskListArray = Array.isArray(tasks) ? tasks : [];
    var task = taskListArray.find(function (t) {
      return t && t.id === id;
    });
    if (!task) return;

    var canDeleteInEdit =
      task.scope === "global" || isTaskInCurrentWorkspace(task);
    setEditingMode(id, { canDelete: canDeleteInEdit });
    var taskNameEl = document.getElementById("task-name");
    var promptTextEl = document.getElementById("prompt-text");
    if (taskNameEl) taskNameEl.value = task.name || "";
    if (promptTextEl)
      promptTextEl.value = typeof task.prompt === "string" ? task.prompt : "";
    if (cronExpression) cronExpression.value = task.cronExpression || "";
    if (cronPreset) cronPreset.value = "";
    updateCronPreview();

    // Restore agent/model — if options not loaded yet, store as pending
    pendingAgentValue = task.agent || "";
    pendingModelValue = task.model || "";
    pendingModelName = task.modelName || "";
    pendingModelVendor = task.modelVendor || "";
    pendingModelFamily = task.modelFamily || "";
    pendingModelVersion = task.modelVersion || "";
    pendingModelReasoningEffort = task.modelReasoningEffort || "";
    if (agentSelect) {
      if (
        pendingAgentValue &&
        selectHasOptionValue(agentSelect, pendingAgentValue)
      ) {
        agentSelect.value = pendingAgentValue;
        pendingAgentValue = "";
      } else if (pendingAgentValue) {
        // Option not yet loaded — will be applied when updateAgents arrives
        agentSelect.value = "";
      }
    }
    if (modelSelect && (pendingModelValue || pendingModelName)) {
      var requestedModelSelection = {
        model: pendingModelValue,
        modelName: pendingModelName,
        modelVendor: pendingModelVendor,
        modelFamily: pendingModelFamily,
        modelVersion: pendingModelVersion,
        modelReasoningEffort: pendingModelReasoningEffort,
      };
      applyModelSelection({
        model: requestedModelSelection.model,
        modelName: requestedModelSelection.modelName,
        modelVendor: requestedModelSelection.modelVendor,
        modelFamily: requestedModelSelection.modelFamily,
        modelVersion: requestedModelSelection.modelVersion,
        modelReasoningEffort: requestedModelSelection.modelReasoningEffort,
      });
      var appliedModelSelection = getCurrentModelSelection();
      if (appliedModelSelection) {
        var hiddenReasoningEffort =
          requestedModelSelection.modelReasoningEffort &&
          !appliedModelSelection.modelReasoningEffort
            ? requestedModelSelection.modelReasoningEffort
            : "";
        clearPendingModelSelection();
        pendingModelReasoningEffort = hiddenReasoningEffort;
      }
    }
    editingTaskEnabled = task.enabled !== false;
    var scopeValue = task.scope || "workspace";
    var scopeRadio = document.querySelector(
      'input[name="scope"][value="' + scopeValue + '"]',
    );
    if (scopeRadio) {
      scopeRadio.checked = true;
    }
    var sourceValue = task.promptSource || "inline";
    var sourceRadio = document.querySelector(
      'input[name="prompt-source"][value="' + sourceValue + '"]',
    );
    if (sourceRadio) {
      sourceRadio.checked = true;
    }

    applyPromptSource(sourceValue, true);
    pendingTemplatePath = task.promptPath || "";
    if (templateSelect) {
      if (
        pendingTemplatePath &&
        selectHasOptionValue(templateSelect, pendingTemplatePath)
      ) {
        templateSelect.value = pendingTemplatePath;
        pendingTemplatePath = "";
      } else if (pendingTemplatePath) {
        templateSelect.value = "";
      }
    }

    if (sourceValue === "inline") {
      setTemplatePromptBaseline(null);
    } else if (promptTextEl) {
      // Re-establish baseline after applyPromptSource(), which may clear it
      // when template options are being refreshed.
      setTemplatePromptBaseline(String(promptTextEl.value || ""));
    }

    if (jitterSecondsInput) {
      jitterSecondsInput.value = String(
        task.jitterSeconds ?? defaultJitterSeconds,
      );
    }
    if (maxExecutionsPerDayInput) {
      maxExecutionsPerDayInput.value = String(task.maxExecutionsPerDay ?? 0);
    }
    if (allowedTimeStartInput) {
      allowedTimeStartInput.value = task.allowedTimeStart || "";
    }
    if (allowedTimeEndInput) {
      allowedTimeEndInput.value = task.allowedTimeEnd || "";
    }
    setAllowedTimeWindowEnabled(
      !!(task.allowedTimeStart || task.allowedTimeEnd),
      false,
    );

    // Clear "run first" checkbox in edit mode (not applicable for existing tasks)
    var runFirstEl = document.getElementById("run-first");
    if (runFirstEl) runFirstEl.checked = false;

    if (autoModeInput) {
      autoModeInput.checked = task.autoMode === true;
    }
    if (chatSessionSelect) {
      chatSessionSelect.value = task.chatSession || "default";
    }
    updateChatSessionDefaultNote();

    // Switch to edit tab (same form)
    switchTab("create");
  };

  if (newTaskBtn) {
    newTaskBtn.addEventListener("click", function () {
      openCreateTaskForm();
    });
  }

  if (openCreateBtn) {
    openCreateBtn.addEventListener("click", function () {
      openCreateTaskForm();
    });
  }

  if (editDeleteBtn) {
    editDeleteBtn.addEventListener("click", function () {
      if (!editingTaskId || !editingTaskCanDelete) {
        return;
      }
      window.deleteTask(editingTaskId);
    });
  }

  if (allowedTimeEnabledInput) {
    allowedTimeEnabledInput.addEventListener("change", function () {
      setAllowedTimeWindowEnabled(allowedTimeEnabledInput.checked, true);
    });
  }

  setAllowedTimeWindowEnabled(
    !!(
      (allowedTimeStartInput && allowedTimeStartInput.value) ||
      (allowedTimeEndInput && allowedTimeEndInput.value)
    ),
    false,
  );

  window.copyPrompt = function (id) {
    // Route through the action callback so that template-based prompts
    // are resolved from the file (consistent with tree view copy).
    vscode.postMessage({ type: "copyTask", taskId: id });
  };

  window.duplicateTask = function (id) {
    vscode.postMessage({ type: "duplicateTask", taskId: id });
  };

  window.moveTaskToCurrentWorkspace = function (id) {
    vscode.postMessage({ type: "moveTaskToCurrentWorkspace", taskId: id });
  };

  window.toggleTask = function (id) {
    vscode.postMessage({ type: "toggleTask", taskId: id });
  };

  window.deleteTask = function (id) {
    if (!id) {
      return;
    }

    // Send delete request to extension (confirmation/not-found handling lives there)
    vscode.postMessage({ type: "deleteTask", taskId: id });
  };

  // Handle messages from extension
  window.addEventListener("message", function (event) {
    var message = event.data;

    try {
      switch (message.type) {
        case "updateTasks":
          if (Array.isArray(message.workspacePaths)) {
            workspacePaths = message.workspacePaths.filter(Boolean);
          }
          renderTaskList(message.tasks);
          if (editingTaskId) {
            var editingTaskList = Array.isArray(tasks) ? tasks : [];
            var editingTask = editingTaskList.find(function (t) {
              return t && t.id === editingTaskId;
            });
            if (!editingTask) {
              setEditingMode(null);
            } else {
              var canDeleteInEdit =
                editingTask.scope === "global" ||
                isTaskInCurrentWorkspace(editingTask);
              setEditingMode(editingTaskId, { canDelete: canDeleteInEdit });
            }
          }
          break;
        case "updateAgents":
          {
            var currentAgentValue =
              pendingAgentValue || (agentSelect ? agentSelect.value : "");
            agents = Array.isArray(message.agents) ? message.agents : [];
            updateAgentOptions();
            if (agentSelect && currentAgentValue) {
              agentSelect.value = currentAgentValue;
              if (agentSelect.value === currentAgentValue) {
                pendingAgentValue = "";
              } else {
                pendingAgentValue = currentAgentValue;
              }
            }
          }
          break;
        case "updateModels":
          {
            var currentModelSelection = getCurrentModelSelection() || {
              model: pendingModelValue,
              modelName: pendingModelName,
              modelVendor: pendingModelVendor,
              modelFamily: pendingModelFamily,
              modelVersion: pendingModelVersion,
              modelReasoningEffort: pendingModelReasoningEffort,
            };
            models = Array.isArray(message.models) ? message.models : [];
            modelPickerDefault = Array.isArray(message.modelPickerDefault)
              ? message.modelPickerDefault
              : [];
            experimentalModelQualityEnabled =
              !!message.experimentalModelQualityEnabled;
            experimentalModelQualityNote =
              typeof message.experimentalModelQualityNote === "string"
                ? message.experimentalModelQualityNote
                : "";
            updateModelExperimentalNote();
            if (
              currentModelSelection &&
              (currentModelSelection.model || currentModelSelection.modelName)
            ) {
              if (applyModelSelection(currentModelSelection)) {
                var appliedSelection = getCurrentModelSelection();
                var hiddenReasoningEffort =
                  currentModelSelection.modelReasoningEffort &&
                  appliedSelection &&
                  !appliedSelection.modelReasoningEffort
                    ? currentModelSelection.modelReasoningEffort
                    : "";
                clearPendingModelSelection();
                pendingModelReasoningEffort = hiddenReasoningEffort;
              } else {
                pendingModelValue = currentModelSelection.model || "";
                pendingModelName = currentModelSelection.modelName || "";
                pendingModelVendor = currentModelSelection.modelVendor || "";
                pendingModelFamily = currentModelSelection.modelFamily || "";
                pendingModelVersion = currentModelSelection.modelVersion || "";
                pendingModelReasoningEffort =
                  currentModelSelection.modelReasoningEffort || "";
              }
            } else {
              updateModelOptions(null);
            }
            updateModelSelectionStatus();
          }
          break;
        case "updatePromptTemplates":
          promptTemplates = Array.isArray(message.templates)
            ? message.templates
            : [];
          {
            var sourceElement = document.querySelector(
              'input[name="prompt-source"]:checked',
            );
            var currentSource = sourceElement ? sourceElement.value : "inline";
            var currentTemplateValue =
              pendingTemplatePath ||
              (templateSelect ? templateSelect.value : "");
            updateTemplateOptions(currentSource, currentTemplateValue);
            if (templateSelect && currentTemplateValue) {
              if (templateSelect.value === currentTemplateValue) {
                pendingTemplatePath = "";
              } else {
                pendingTemplatePath = currentTemplateValue;
              }
            }
            if (currentSource === "local" || currentSource === "global") {
              if (templateSelectGroup)
                templateSelectGroup.style.display = "block";
            } else {
              if (templateSelectGroup)
                templateSelectGroup.style.display = "none";
            }
          }
          break;
        case "updateDefaults":
          defaultScope =
            message.defaultScope === "global" ? "global" : "workspace";
          defaultAutoMode = !!message.defaultAutoMode;
          defaultChatSession =
            message.defaultChatSession === "continue" ? "continue" : "new";
          if (typeof message.defaultChatSessionNote === "string") {
            defaultChatSessionNote = message.defaultChatSessionNote;
          }
          {
            var rawJitter =
              typeof message.defaultJitterSeconds === "number"
                ? message.defaultJitterSeconds
                : Number(message.defaultJitterSeconds);
            if (isFinite(rawJitter)) {
              var boundedJitter = Math.floor(rawJitter);
              defaultJitterSeconds = Math.min(Math.max(boundedJitter, 0), 1800);
            }
          }
          applyUpdatedDefaultsToCreateForm();
          break;
        case "promptTemplateLoaded":
          {
            var loadedPath = message.path ? String(message.path) : "";
            if (loadedPath) {
              clearTemplateLoading(loadedPath);
            }
            var promptSourceEl = document.querySelector(
              'input[name="prompt-source"]:checked',
            );
            var currentPromptSource = promptSourceEl
              ? promptSourceEl.value
              : "inline";
            if (
              currentPromptSource !== "local" &&
              currentPromptSource !== "global"
            ) {
              break;
            }
            if (
              templateSelect &&
              message.path &&
              templateSelect.value !== message.path
            ) {
              break;
            }
            var promptTextEl = document.getElementById("prompt-text");
            if (promptTextEl) {
              promptTextEl.value = message.content;
              setTemplatePromptBaseline(String(message.content || ""));
            }
          }
          break;
        case "switchToList":
          clearPendingSubmitState();
          resetForm();
          switchTab("list");
          if (message.successMessage) {
            var toast = document.getElementById("success-toast");
            if (toast) {
              var prefix = strings.webviewSuccessPrefix || "\u2714 ";
              toast.textContent = prefix + message.successMessage;
              toast.style.display = "block";
              toast.style.opacity = "1";
              setTimeout(function () {
                toast.style.opacity = "0";
              }, 3000);
              setTimeout(function () {
                toast.style.display = "none";
                toast.style.opacity = "1";
              }, 3500);
            }
          }
          break;
        case "focusTask":
          switchTab("list");
          setTimeout(function () {
            var list = document.querySelectorAll(".task-card");
            var card = null;
            for (var i = 0; i < list.length; i++) {
              var el = list[i];
              if (
                el &&
                el.getAttribute &&
                el.getAttribute("data-id") === message.taskId
              ) {
                card = el;
                break;
              }
            }
            if (card) card.scrollIntoView({ behavior: "smooth" });
          }, 100);
          break;
        case "editTask":
          if (message.taskId && typeof window.editTask === "function") {
            window.editTask(message.taskId);
          }
          break;
        case "startCreateTask":
          openCreateTaskForm();
          break;
        case "showError":
          var rawText =
            message.text == null
              ? String(strings.webviewUnknown || "")
              : String(message.text);
          var safeText = sanitizeAbsolutePaths(rawText.split(/\r?\n/)[0]);
          var displayText = safeText.trim()
            ? safeText
            : String(strings.webviewUnknown || "");
          showFormError(displayText, 8000);
          setTemplatePromptBaseline(null);
          clearTemplateLoading();
          clearPendingSubmitState();
          switchTab("create");
          break;
      }
    } catch (e) {
      var prefix = strings.webviewClientErrorPrefix || "";
      var rawError = e && e.message ? e.message : e;
      rawError = String(rawError).split(/\r?\n/)[0];
      var safeError = sanitizeAbsolutePaths(rawError);
      var displayError = safeError.trim()
        ? safeError
        : String(strings.webviewUnknown || "");
      showFormError(prefix + displayError);
      clearTemplateLoading();
      clearPendingSubmitState();
      switchTab("create");
    }
  });

  // Initial render
  renderTaskList(tasks);
  scheduleLayoutRefresh();

  // Notify extension that webview is ready
  vscode.postMessage({ type: "webviewReady" });
})();

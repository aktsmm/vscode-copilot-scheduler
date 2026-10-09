import hashlib
import json
import subprocess
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "media/schedulerWebview.js"
EXTRACT = r"""
const fs = require('fs'), ts = require('typescript');
const source = ts.createSourceFile('webview.js', fs.readFileSync(process.argv[1], 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['copyModelConfigurationForForm', 'isEditableModelConfiguration',
  'clearUnavailableModelOptions', 'buildUnavailableModelLabel', 'clearModelVariantOptions',
  'updateModelExperimentalNote', 'updateModelVariantOptions', 'renderModelConfigurationControls',
  'updateModelOptions', 'ensureUnavailableModelOption']);
const found = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) found.set(node.name.text, node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
if (found.size !== names.size) throw new Error('Production function extraction failed');
console.log([...found.values()].join('\n'));
"""
BOOTSTRAP = """
var modelSelect = document.querySelector('#model-select');
var modelVariantSelect = document.querySelector('#model-variant-select');
var modelVariantGroup = document.querySelector('#model-variant-group');
var modelConfigurationGroup = document.querySelector('#model-configuration-group');
var modelConfigurationControls = document.querySelector('#model-configuration-controls');
var modelConfigurationNote = document.querySelector('#model-configuration-note');
var modelExperimentalNote = document.querySelector('#model-experimental-note');
var modelConfigurationReset = null;
var modelConfigurationState, activeConfigurationModel, pendingModelReasoningEffort = '';
var modelConfigurationExecutionEnabled = true, experimentalModelQualityEnabled = true;
var experimentalModelQualityNote = 'Legacy fallback';
var strings = { labelInheritModelOptions: 'Inherit', labelModelUnavailableSuffix: 'Unavailable',
  labelDynamicModelOptionsBlocked: 'Per request', labelModelSchemaUnavailable: 'Unavailable schema',
  placeholderSelectModel: 'Select', placeholderSelectModelVariant: 'Default',
  placeholderNoModels: 'No models', labelModelNote: 'Preview' };
var groups = [];
function getActiveModelPickerGroups() { return groups; }
function findModelPickerGroup(items, key) { return items.find(item => item.key === key); }
function findModelPickerSelection(items, selection) {
  if (!selection) return null;
  for (const group of items.filter(Boolean)) for (const variant of group.variants)
    if (variant.model.id === selection.model && variant.model.vendor === selection.modelVendor &&
      (variant.reasoningEffort || '') === (selection.modelReasoningEffort || '')) return { group, variant };
  return null;
}
function escapeHtml(value) { const span = document.createElement('span'); span.textContent = value; return span.innerHTML; }
function escapeAttr(value) { return escapeHtml(value).replaceAll('"', '&quot;'); }
function selectHasOptionValue(select, value) { return [...select.options].some(option => option.value === value); }
function rescueFocusFrom(container, target) { if (container.contains(document.activeElement)) target.focus(); }
function scheduleLayoutRefresh() {}
function updateModelSelectionStatus() {}
window.fixture = {
  refresh: (items, selection) => { groups = items; return updateModelOptions(selection); },
  missing: selection => ensureUnavailableModelOption(modelSelect, selection),
  state: () => modelConfigurationState
};
"""
HTML = """<style>
body { margin: 16px; } select { max-width: 100%; width: 100%; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
</style><select id="model-select"></select>
<div id="model-variant-group"><select id="model-variant-select"></select></div>
<p id="model-experimental-note"></p><div id="model-configuration-group">
<div class="form-grid" id="model-configuration-controls"></div><p id="model-configuration-note"></p></div>"""


def main():
    functions = subprocess.run(
        ["node", "-e", EXTRACT, str(SCRIPT)],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    ).stdout
    model = {"id": "synthetic", "vendor": "fixture", "configurationStatus": "available",
             "configurationOptions": [{"key": "contextSize", "label": "Context",
                                       "choices": [{"value": 4096, "label": "4096"}]}]}
    group = {"key": "synthetic", "vendor": "fixture", "label": "Synthetic",
             "variants": [{"key": "default", "model": model}]}
    inherited = {"model": "synthetic", "modelVendor": "fixture", "modelConfiguration": {}}
    saved = {**inherited, "modelConfiguration": {"contextSize": 4096}}
    results = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True, args=["--disable-sync"])
        try:
            for label, width in [("desktop", 900), ("narrow", 360)]:
                page = browser.new_page(viewport={"width": width, "height": 500})
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.set_content(HTML)
                page.add_script_tag(content=BOOTSTRAP + functions)
                page.evaluate("args => fixture.refresh(...args)", [[group], inherited])
                control = page.locator("#model-configuration-contextSize")
                expect(control).to_be_visible()
                control.select_option("0")
                assert page.evaluate("fixture.state()") == {"contextSize": 4096}
                control.focus()
                page.evaluate("args => fixture.refresh(...args)", [[], saved])
                expect(page.locator("#model-select")).to_be_focused()
                expect(control).to_have_value("unavailable")
                expect(control.locator("option[value='0']")).to_have_count(0)
                assert page.evaluate("fixture.state()") == saved["modelConfiguration"]
                page.evaluate("selection => fixture.missing(selection)", saved)
                expect(control).to_have_value("unavailable")
                expect(page.locator("#model-experimental-note")).to_be_hidden()
                page.evaluate("args => fixture.refresh(...args)", [[group], saved])
                expect(control).to_have_value("0")
                legacy_group = {**group, "variants": [*group["variants"],
                  {"key": "high", "model": model, "reasoningEffort": "high"}]}
                legacy = {"model": "synthetic", "modelVendor": "fixture", "modelReasoningEffort": "high"}
                page.evaluate("args => fixture.refresh(...args)", [[legacy_group], legacy])
                variant = page.locator("#model-variant-select")
                expect(variant).to_be_visible()
                variant.focus()
                page.evaluate("args => fixture.refresh(...args)", [[legacy_group], inherited])
                expect(variant).to_be_hidden()
                expect(page.locator("#model-select")).to_be_focused()
                page.evaluate("args => fixture.refresh(...args)", [[], inherited])
                expect(page.locator("#model-configuration-group")).to_be_hidden()
                expect(page.locator("#model-experimental-note")).to_be_hidden()
                assert page.locator("input[type='checkbox']").count() == 0
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                assert not errors, errors
                results.append({"viewport": label, "result": "PASS"})
                page.close()
        finally:
            browser.close()
    print(json.dumps({"component": "model options catalog transitions",
                      "scriptSha256": hashlib.sha256(SCRIPT.read_bytes()).hexdigest(),
                      "results": results,
                      "limitations": "Production functions with synthetic catalog in real DOM; not full VS Code host or screen-reader verification"}, indent=2))


if __name__ == "__main__":
    main()
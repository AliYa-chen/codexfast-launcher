#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../bin/codexfast-launcher.mjs", import.meta.url));
const scriptDir = path.dirname(launcher);
const bundledTarball = path.join(scriptDir, "vendor", "codexfast-0.48.0.tgz");

function run(args, env = {}) {
  return spawnSync(process.execPath, [launcher, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEXFAST_MODEL_ID: "",
      CODEXFAST_MODEL_DISPLAY_NAME: "",
      CODEXFAST_ULTRAFAST: "",
      ...(fs.existsSync(bundledTarball) ? { CODEXFAST_PACKAGE_TARBALL: bundledTarball } : {}),
      ...env,
    },
    timeout: 30_000,
  });
}

function output(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function preparedDetails(result) {
  const json = result.stdout.match(/(\{\n  "version":[\s\S]*\})\s*$/)?.[1];
  assert.ok(json, output(result));
  return JSON.parse(json);
}

const status = run(["status"]);
assert.equal(status.status, 0, output(status));
assert.match(output(status), /Version key: \d+\.\d+\.\d+\+\d+/);
assert.match(output(status), /Codex\.app running:/);
assert.match(output(status), /Codex\.app main running:/);

const dryRun = run(["relaunch", "--dry-run"]);
assert.equal(dryRun.status, 0, output(dryRun));
assert.match(output(dryRun), /Dry run:/);
assert.match(output(dryRun), /Would request Codex\.app to quit only if its main process is running/);
assert.match(output(dryRun), /Would start runtime patch launch/);

const processClassification = run(["__selftest-process-classification"]);
assert.equal(processClassification.status, 0, output(processClassification));
assert.match(output(processClassification), /Process classification self-test passed/);

const prepared = run(["prepare"]);
assert.equal(prepared.status, 0, output(prepared));
const preparedLauncher = output(prepared).match(/"preparedLauncher": "([^"]+)"/)?.[1];
assert.ok(preparedLauncher, output(prepared));
const preparedSource = fs.readFileSync(preparedLauncher, "utf8");
const preparedMetadata = preparedDetails(prepared);
assert.ok(preparedMetadata.nativeUltrafast, "a current client should prepare native Ultrafast metadata");
assert.ok(preparedMetadata.nativeUltrafast.modelCount > 0);
assert.ok(Array.isArray(preparedMetadata.nativeUltrafast.patchedModels));
assert.ok(["builtin-cli", "explicit-file"].includes(preparedMetadata.nativeUltrafast.catalogSource));
for (const key of ["cliPath", "wrapperPath", "catalogPath"]) {
  assert.ok(path.isAbsolute(preparedMetadata.nativeUltrafast[key]), `${key} must be absolute`);
}
assert.ok(preparedSource.includes(JSON.stringify({
  CODEX_CLI_PATH: preparedMetadata.nativeUltrafast.wrapperPath,
  CODEX_APP_SERVER_FORCE_CLI: "1",
})), "prepared App launch environment should select the native wrapper and CLI transport");
assert.doesNotMatch(preparedSource, /codexfast-model-override-current-extension/);
assert.match(preparedSource, /codexfast-service-tier-request-personal-access-token-extension/);
assert.match(preparedSource, /codexfast-service-tier-access-extension/);
assert.match(preparedSource, /codexfast-runtime-extension-filter-bridge/);
assert.match(preparedSource, /codexfast-ultrafast-extension/);
assert.match(
  preparedSource,
  /function childEnvWithAutomaticUpdateSetting\(env = process\.env\) \{\n    \/\/ codexfast-launcher: remove an inherited codexfast hook/,
);
assert.doesNotMatch(preparedSource, /CODEXFAST_ORIGINAL_NODE_OPTIONS/);

const childEnvFunctionSource = preparedSource.match(
  /function childEnvWithAutomaticUpdateSetting\(env = process\.env\) \{[\s\S]*?\n\}/,
)?.[0];
assert.ok(childEnvFunctionSource, "prepared launcher should contain the child environment helper");
const childEnvWithAutomaticUpdateSetting = new Function(
  `${childEnvFunctionSource}\nreturn childEnvWithAutomaticUpdateSetting;`,
)();
const cleanEnvironment = { NODE_OPTIONS: "--trace-warnings" };
assert.strictEqual(childEnvWithAutomaticUpdateSetting(cleanEnvironment), cleanEnvironment);
const inheritedHookEnvironment = {
  NODE_OPTIONS: '--trace-warnings --require="/Users/example/.codex/.tmp/codexfast/main-process-hook.cjs"',
};
assert.deepEqual(childEnvWithAutomaticUpdateSetting(inheritedHookEnvironment), {
  NODE_OPTIONS: "--trace-warnings",
});
assert.equal(
  childEnvWithAutomaticUpdateSetting({
    NODE_OPTIONS: '--require="/Users/example/.codex/.tmp/codexfast/main-process-hook.cjs"',
  }).NODE_OPTIONS,
  undefined,
);

const defaultPatcherSourceLiteral = preparedSource.match(/const __PATCHER_SOURCE__ = ((?:"(?:[^"\\]|\\.)*"));/)?.[1];
assert.ok(defaultPatcherSourceLiteral, "prepared launcher should embed runtime patcher source");
const defaultPatcherSource = eval(defaultPatcherSourceLiteral);
assert.doesNotMatch(defaultPatcherSource, /\.\.\.UPDATE_TARGET_SPECS/);
const applyDefaultRuntimePatchesToBody = new Function(`${defaultPatcherSource}\nreturn applyRuntimePatchesToBody;`)();
const automaticUpdateSettingsBody =
  "preventSleepWhileRunning:r({agentAccess:`read-write`,default:!1,description:`Whether the machine stays awake while Codex is running`,key:`preventSleepWhileRunning`,schema:t}),";
const automaticUpdateSettingsPatch = applyDefaultRuntimePatchesToBody(
  "app://-/assets/app-main.js",
  automaticUpdateSettingsBody,
);
assert.equal(automaticUpdateSettingsPatch.content, automaticUpdateSettingsBody);
assert.ok(!automaticUpdateSettingsPatch.patchedLabels.includes("Disable automatic updates schema"));

const personalAccessTokenServiceTierBody =
  "async function Z$i(e,t){let n=await q$i(e,t);if(n!==`chatgpt`&&n!==`personalAccessToken`)return!1;let r=await XMe(e,t,{priority:`critical`});return e.query.setData(yd,{authMethod:n,hostId:t},r),r.requirements?.featureRequirements?.fast_mode!==!1}";
const personalAccessTokenServiceTierPatch = applyDefaultRuntimePatchesToBody(
  "app://-/assets/app-initial.js",
  personalAccessTokenServiceTierBody,
);
assert.notEqual(personalAccessTokenServiceTierPatch.content, personalAccessTokenServiceTierBody);
assert.match(
  personalAccessTokenServiceTierPatch.content,
  /if\(n!==`chatgpt`&&n!==`personalAccessToken`\)return!0/,
);
assert.ok(personalAccessTokenServiceTierPatch.patchedLabels.includes("Speed service tier request allowance"));

const runtimePatcherSourceForVersionSource = preparedSource
  .match(
    /function runtimePatcherSourceForVersion\(patcherSource, versionKey\) \{[\s\S]*?\n\}\nasync function enableRuntimePatchInterception/,
  )?.[0]
  .replace(/\nasync function enableRuntimePatchInterception$/, "");
assert.ok(runtimePatcherSourceForVersionSource, "prepared launcher should contain the runtime target filter");
const runtimePatcherSourceForVersion = new Function(
  [
    'const runtimePatchNoPluginTargetsVersionKeys = new Set(["test-version"]);',
    'const runtimePatchPluginTargetIdPrefixes = ["plugins-"];',
    "const runtimePatchOfficialGpt56TargetIds = new Set();",
    "const usesOfficialGpt56 = () => false;",
    runtimePatcherSourceForVersionSource,
    "return runtimePatcherSourceForVersion;",
  ].join("\n"),
)();
const filteredPatcherSource = runtimePatcherSourceForVersion(defaultPatcherSource, "test-version");
const applyFilteredRuntimePatchesToBody = new Function(`${filteredPatcherSource}\nreturn applyRuntimePatchesToBody;`)();
const filteredPersonalAccessTokenPatch = applyFilteredRuntimePatchesToBody(
  "app://-/assets/app-initial.js",
  personalAccessTokenServiceTierBody,
);
assert.notEqual(filteredPersonalAccessTokenPatch.content, personalAccessTokenServiceTierBody);
assert.match(
  filteredPersonalAccessTokenPatch.content,
  /if\(n!==`chatgpt`&&n!==`personalAccessToken`\)return!0/,
);
assert.ok(filteredPersonalAccessTokenPatch.patchedLabels.includes("Speed service tier request allowance"));

// Exact request function and React cache layout from client 26.1007.21159.
const currentServiceTierRequestBody =
  "async function bga(e,t){let n=await _ga(e,t);if(n!==`chatgpt`&&n!==`personalAccessToken`)return null;let r=await KPe(e,t,{priority:`critical`});return e.query.setData(Hd,{authMethod:n,hostId:t},r),oee(r)}";
const currentServiceTierUiBody =
  "function KVi(e){let t=(0,qVi.c)(10),n=G(Li),r=e?.hostId??n,i=BYe(r),a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=Zs(Hd,s),u=!!i?.isLoading||a&&l,d;t[3]!==c||t[4]!==u||t[5]!==a?(d=a&&!u&&c!=null?oee(c):null,t[3]=c,t[4]=u,t[5]=a,t[6]=d):d=t[6];let f=d,p;return t[7]!==u||t[8]!==f?(p={serviceTierAccess:f,isLoading:u},t[7]=u,t[8]=f,t[9]=p):p=t[9],p}";
const serviceTierRequestLabel = "Speed service tier request allowance";
const serviceTierAccessLabel = "Speed service tier access";

async function assertCurrentServiceTierAccessBehavior(applyPatches) {
  const requestPatch = applyPatches("app://-/assets/app-initial.js", currentServiceTierRequestBody);
  assert.notEqual(requestPatch.content, currentServiceTierRequestBody);
  assert.ok(requestPatch.patchedLabels.includes(serviceTierRequestLabel));
  for (const authMethod of ["apiKey", "chatgpt", "personalAccessToken"]) {
    for (const access of [{ fast: true, ultrafast: false }, { fast: false, ultrafast: false }]) {
      const response = Object.freeze({ access: Object.freeze(access) });
      const calls = [];
      const queryKey = {};
      const store = { query: { setData: (...args) => calls.push(["cache", ...args]) } };
      const request = new Function("_ga", "KPe", "Hd", "oee", `${requestPatch.content};return bga;`)(
        async () => authMethod,
        async (...args) => { calls.push(["fetch", ...args]); return response; },
        queryKey,
        (data) => { calls.push(["access", data]); return data.access; },
      );
      const actual = await request(store, "local");
      if (authMethod === "apiKey") {
        assert.deepEqual(actual, { fast: true, ultrafast: true });
        assert.deepEqual(calls, [], "API key access should not fetch ChatGPT requirements");
      } else {
        assert.strictEqual(actual, response.access, "account speed permissions must remain authoritative");
        assert.deepEqual(calls, [
          ["fetch", store, "local", { priority: "critical" }],
          ["cache", queryKey, { authMethod, hostId: "local" }, response],
          ["access", response],
        ]);
      }
    }
  }
  const repeatedRequest = applyPatches("app://-/assets/app-initial.js", requestPatch.content);
  assert.equal(repeatedRequest.content, requestPatch.content);
  assert.ok(repeatedRequest.alreadyPatchedLabels.includes(serviceTierRequestLabel));
  assert.ok(!repeatedRequest.patchedLabels.includes(serviceTierRequestLabel));

  const uiPatch = applyPatches("app://-/assets/app-initial.js", currentServiceTierUiBody);
  assert.notEqual(uiPatch.content, currentServiceTierUiBody);
  assert.ok(uiPatch.patchedLabels.includes(serviceTierAccessLabel));
  assert.match(uiPatch.content, /t\[3\]=c,t\[4\]=u,t\[5\]=a,t\[6\]=d/);
  for (const authMethod of ["apiKey", "chatgpt", "personalAccessToken"]) {
    const cache = Array(10).fill(Symbol("uncached"));
    const access = Object.freeze({ fast: false, ultrafast: false });
    let state = { isLoading: false, isPending: false, data: { access } };
    const queryKey = {};
    const ui = new Function("qVi", "G", "Li", "BYe", "Zs", "Hd", "oee", `${uiPatch.content};return KVi;`)(
      { c: () => cache },
      () => "local",
      {},
      () => ({ authMethod, isLoading: state.isLoading }),
      (key, params) => {
        assert.strictEqual(key, queryKey);
        assert.deepEqual(params, { authMethod, hostId: "local" });
        return { data: state.data, isPending: state.isPending };
      },
      queryKey,
      (data) => data.access,
    );
    const result = ui({ hostId: "local" });
    if (authMethod === "apiKey") assert.deepEqual(result.serviceTierAccess, { fast: true, ultrafast: true });
    else assert.strictEqual(result.serviceTierAccess, access);
    assert.strictEqual(ui({ hostId: "local" }), result, "cached UI access should preserve its result identity");
    state = { ...state, isLoading: true };
    assert.deepEqual(ui(), { serviceTierAccess: null, isLoading: true });
    state = { ...state, isLoading: false, isPending: true };
    if (authMethod === "apiKey") {
      assert.deepEqual(ui(), { serviceTierAccess: { fast: true, ultrafast: true }, isLoading: false });
    } else {
      assert.deepEqual(ui(), { serviceTierAccess: null, isLoading: true });
      state = { ...state, isPending: false, data: null };
      assert.deepEqual(ui(), { serviceTierAccess: null, isLoading: false });
    }
  }
  const repeatedUi = applyPatches("app://-/assets/app-initial.js", uiPatch.content);
  assert.equal(repeatedUi.content, uiPatch.content);
  assert.ok(repeatedUi.alreadyPatchedLabels.includes(serviceTierAccessLabel));
  assert.ok(!repeatedUi.patchedLabels.includes(serviceTierAccessLabel));
  for (const unrelated of [
    "function unrelated(a,u,c){let d=a&&!u&&c!=null?oee(c):null;return {serviceTierAccess:d}}",
    currentServiceTierUiBody.replace("serviceTierAccess:f", "otherFeatureAccess:f"),
  ]) {
    assert.equal(applyPatches("app://-/assets/unrelated.js", unrelated).content, unrelated);
  }
}

await assertCurrentServiceTierAccessBehavior(applyDefaultRuntimePatchesToBody);
await assertCurrentServiceTierAccessBehavior(applyFilteredRuntimePatchesToBody);

const ultrafastLabel = "Ultrafast model service tiers";
const currentUltrafastModelListBody =
  "select:({data:n})=>Ali({additionalAvailableModels:new Set(e),apiKeyDaybreakSupported:h,authMethod:t,availableModels:v.availableModels,defaultModel:v.defaultModel,enabledReasoningEfforts:_,hasConfiguredModelCatalog:r,includeUltraReasoningEffort:y,isCustomModelProvider:o,models:n,useHiddenModels:v.useHiddenModels})";
const currentUltrafastSelectorState = {
  e: ["gpt-6.1-sol"],
  h: true,
  t: "personalAccessToken",
  v: { availableModels: new Set(["gpt-6.1-sol"]), defaultModel: "gpt-6.1-sol", useHiddenModels: false },
  _: new Set(["low", "high"]),
  r: true,
  y: false,
  o: true,
};

function compileCurrentUltrafastSelector(body) {
  assert.ok(body.startsWith("select:"));
  return new Function(
    "Ali",
    ...Object.keys(currentUltrafastSelectorState),
    `return (${body.slice("select:".length)});`,
  )((fields) => fields, ...Object.values(currentUltrafastSelectorState));
}

function assertUltrafastModelBehavior(applyPatches) {
  const result = applyPatches("app://-/assets/use-model-list.js", currentUltrafastModelListBody);
  assert.notEqual(result.content, currentUltrafastModelListBody);
  assert.match(result.content, /codexfast-ultrafast-model-tiers/);
  assert.ok(result.patchedLabels.includes(ultrafastLabel));
  const select = compileCurrentUltrafastSelector(result.content);
  const priority = Object.freeze({ id: "priority", name: "Fast", description: "1.5x speed", extra: "keep" });
  const standard = Object.freeze({ id: "standard", name: "Standard", description: "Default" });
  const existingUltrafast = Object.freeze({ id: "ultrafast", name: "Custom ultrafast", description: "Preserve" });
  const namedUltrafast = Object.freeze({ id: "custom-ultrafast", name: "Ultrafast", description: "Preserve name" });
  const models = Object.freeze([
    Object.freeze({ model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", serviceTiers: Object.freeze([standard, priority]) }),
    Object.freeze({ model: "standard-only", serviceTiers: Object.freeze([standard]) }),
    Object.freeze({ model: "no-tiers" }),
    Object.freeze({ model: "already-ultrafast", serviceTiers: Object.freeze([priority, existingUltrafast]) }),
    Object.freeze({ model: "named-ultrafast", serviceTiers: Object.freeze([priority, namedUltrafast]) }),
    Object.freeze({ model: "fast-id", serviceTiers: Object.freeze([Object.freeze({ id: "fast", name: "Custom fast" })]) }),
    Object.freeze({ model: "fast-name", serviceTiers: Object.freeze([Object.freeze({ id: "custom-fast", name: "Fast" })]) }),
    Object.freeze({ model: "priority-name", serviceTiers: Object.freeze([Object.freeze({ id: "custom-priority", name: "Priority" })]) }),
  ]);
  const selected = select({ data: models });
  assert.deepEqual(selected.additionalAvailableModels, new Set(currentUltrafastSelectorState.e));
  assert.equal(selected.apiKeyDaybreakSupported, currentUltrafastSelectorState.h);
  assert.equal(selected.authMethod, currentUltrafastSelectorState.t);
  assert.strictEqual(selected.availableModels, currentUltrafastSelectorState.v.availableModels);
  assert.equal(selected.defaultModel, currentUltrafastSelectorState.v.defaultModel);
  assert.strictEqual(selected.enabledReasoningEfforts, currentUltrafastSelectorState._);
  assert.equal(selected.hasConfiguredModelCatalog, currentUltrafastSelectorState.r);
  assert.equal(selected.includeUltraReasoningEffort, currentUltrafastSelectorState.y);
  assert.equal(selected.isCustomModelProvider, currentUltrafastSelectorState.o);
  assert.equal(selected.useHiddenModels, currentUltrafastSelectorState.v.useHiddenModels);
  assert.deepEqual(selected.models.map((model) => model.model), models.map((model) => model.model));
  assert.equal(selected.models[0].displayName, models[0].displayName);
  assert.notStrictEqual(selected.models[0], models[0]);
  assert.notStrictEqual(selected.models[0].serviceTiers, models[0].serviceTiers);
  assert.strictEqual(selected.models[0].serviceTiers[0], standard);
  assert.strictEqual(selected.models[0].serviceTiers[1], priority);
  assert.deepEqual(selected.models[0].serviceTiers[2], { id: "ultrafast", name: "Ultrafast", description: "" });
  assert.equal(models[0].serviceTiers.length, 2, "the original catalog must remain unchanged");
  for (const index of [1, 2, 3, 4]) {
    assert.strictEqual(selected.models[index], models[index]);
  }
  for (const index of [5, 6, 7]) {
    assert.strictEqual(selected.models[index].serviceTiers[0], models[index].serviceTiers[0]);
    assert.deepEqual(selected.models[index].serviceTiers[1], { id: "ultrafast", name: "Ultrafast", description: "" });
  }
  const repeatedSelection = select({ data: selected.models });
  for (let index = 0; index < selected.models.length; index += 1) {
    assert.strictEqual(repeatedSelection.models[index], selected.models[index]);
  }
  const repeatedPatch = applyPatches("app://-/assets/use-model-list.js", result.content);
  assert.equal(repeatedPatch.content, result.content);
  assert.ok(repeatedPatch.alreadyPatchedLabels.includes(ultrafastLabel));
  assert.ok(!repeatedPatch.patchedLabels.includes(ultrafastLabel));
  const unrelatedBody = "const model={model:`gpt-6.1-sol`,serviceTiers:[{id:`priority`,name:`Fast`}]};";
  const unrelatedResult = applyPatches("app://-/assets/unrelated.js", unrelatedBody);
  assert.equal(unrelatedResult.content, unrelatedBody);
  assert.ok(!unrelatedResult.matchedLabels.includes(ultrafastLabel));
}

assertUltrafastModelBehavior(applyDefaultRuntimePatchesToBody);
assertUltrafastModelBehavior(applyFilteredRuntimePatchesToBody);

const ultrafastDisabledPrepared = run(["prepare"], { CODEXFAST_ULTRAFAST: "0" });
assert.equal(ultrafastDisabledPrepared.status, 0, output(ultrafastDisabledPrepared));
assert.equal(preparedDetails(ultrafastDisabledPrepared).nativeUltrafast, null);
const ultrafastDisabledPreparedLauncher = output(ultrafastDisabledPrepared).match(/"preparedLauncher": "([^"]+)"/)?.[1];
assert.ok(ultrafastDisabledPreparedLauncher, output(ultrafastDisabledPrepared));
const ultrafastDisabledSource = fs.readFileSync(ultrafastDisabledPreparedLauncher, "utf8");
assert.doesNotMatch(ultrafastDisabledSource, /codexfast-ultrafast-extension/);
const ultrafastDisabledPatcherSourceLiteral = ultrafastDisabledSource.match(/const __PATCHER_SOURCE__ = ((?:"(?:[^"\\]|\\.)*"));/)?.[1];
assert.ok(ultrafastDisabledPatcherSourceLiteral);
const applyUltrafastDisabledPatches = new Function(
  `${JSON.parse(ultrafastDisabledPatcherSourceLiteral)}\nreturn applyRuntimePatchesToBody;`,
)();
assert.equal(
  applyUltrafastDisabledPatches("app://-/assets/use-model-list.js", currentUltrafastModelListBody).content,
  currentUltrafastModelListBody,
);

const oldAppBundle = fs.mkdtempSync(path.join(os.tmpdir(), "codexfast-launcher-old-app-test-"));
try {
  fs.mkdirSync(path.join(oldAppBundle, "Contents"));
  fs.writeFileSync(
    path.join(oldAppBundle, "Contents", "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>26.1001.10000</string><key>CFBundleVersion</key><string>1</string><key>CFBundleExecutable</key><string>Codex</string></dict></plist>',
  );
  const oldAppPrepared = run(["prepare"], { CODEXFAST_APP_BUNDLE: oldAppBundle });
  assert.equal(oldAppPrepared.status, 0, output(oldAppPrepared));
  assert.equal(preparedDetails(oldAppPrepared).nativeUltrafast, null);
  const oldAppPreparedLauncher = output(oldAppPrepared).match(/"preparedLauncher": "([^"]+)"/)?.[1];
  assert.ok(oldAppPreparedLauncher, output(oldAppPrepared));
  assert.doesNotMatch(fs.readFileSync(oldAppPreparedLauncher, "utf8"), /codexfast-ultrafast-extension/);
} finally {
  fs.rmSync(oldAppBundle, { recursive: true, force: true });
}

const modelOverridePrepared = run(["prepare"], {
  CODEXFAST_MODEL_ID: "gpt-5.6",
  CODEXFAST_MODEL_DISPLAY_NAME: "GPT-5.6",
});
assert.equal(modelOverridePrepared.status, 0, output(modelOverridePrepared));
const modelOverridePreparedLauncher = output(modelOverridePrepared).match(/"preparedLauncher": "([^"]+)"/)?.[1];
assert.ok(modelOverridePreparedLauncher, output(modelOverridePrepared));
const modelOverridePreparedSource = fs.readFileSync(modelOverridePreparedLauncher, "utf8");
assert.match(modelOverridePreparedSource, /codexfast-model-override-current-extension/);
assert.match(modelOverridePreparedSource, /codexfast-runtime-extension-filter-bridge/);

const patcherSourceLiteral = modelOverridePreparedSource.match(/const __PATCHER_SOURCE__ = ((?:"(?:[^"\\]|\\.)*"));/)?.[1];
assert.ok(patcherSourceLiteral, "prepared launcher should embed runtime patcher source");
const patcherSource = eval(patcherSourceLiteral);
const applyRuntimePatchesToBody = new Function(`${patcherSource}\nreturn applyRuntimePatchesToBody;`)();
const currentModelListBody =
  "queryFn:()=>Ch(`list-models-for-host`,{hostId:r,includeHidden:!0,cursor:null,limit:a}),select:({data:r})=>Jv({authMethod:t,availableModels:new Set(e),defaultModel:n,enabledReasoningEfforts:c,includeUltraReasoningEffort:l,models:r,useHiddenModels:o})";
const modelListPatch = applyRuntimePatchesToBody("app://-/assets/app-main.js", currentModelListBody);
assert.notEqual(modelListPatch.content, currentModelListBody);
assert.match(modelListPatch.content, /codexfast-model-override-list/);
assert.match(modelListPatch.content, /gpt-5\.6/);
assert.ok(modelListPatch.patchedLabels.includes("GPT-5.6 model list current"));

const currentModelListBodyWithAdditionalModels =
  "queryFn:()=>Ch(`list-models-for-host`,{hostId:r,includeHidden:!0,cursor:null,limit:a}),select:({data:r})=>Jv({additionalAvailableModels:new Set(e),authMethod:t,availableModels:n.availableModels,defaultModel:n.defaultModel,enabledReasoningEfforts:c,includeUltraReasoningEffort:l,isCustomModelProvider:i,models:r,useHiddenModels:n.useHiddenModels})";
const modelListPatchWithAdditionalModels = applyRuntimePatchesToBody(
  "app://-/assets/app-main.js",
  currentModelListBodyWithAdditionalModels,
);
assert.notEqual(modelListPatchWithAdditionalModels.content, currentModelListBodyWithAdditionalModels);
assert.match(modelListPatchWithAdditionalModels.content, /codexfast-model-override-list/);
assert.match(modelListPatchWithAdditionalModels.content, /additionalAvailableModels:new Set\(\[\.\.\.e,\"gpt-5\.6\"\]\)/);
assert.match(modelListPatchWithAdditionalModels.content, /availableModels:new Set\(\[\.\.\.n\.availableModels,\"gpt-5\.6\"\]\)/);
assert.match(modelListPatchWithAdditionalModels.content, /isCustomModelProvider:i/);
assert.ok(modelListPatchWithAdditionalModels.patchedLabels.includes("GPT-5.6 model list current"));

const filteredModelOverridePatcherSource = runtimePatcherSourceForVersion(patcherSource, "test-version");
const applyFilteredModelOverridePatches = new Function(
  `${filteredModelOverridePatcherSource}\nreturn applyRuntimePatchesToBody;`,
)();
const filteredModelOverridePatch = applyFilteredModelOverridePatches(
  "app://-/assets/app-main.js",
  currentModelListBodyWithAdditionalModels,
);
const modelOverrideCatalog = Object.freeze([
  Object.freeze({ model: "gpt-5.5", serviceTiers: Object.freeze([{ id: "priority", name: "Fast", description: "" }]) }),
]);
for (const overridePatch of [modelListPatchWithAdditionalModels, filteredModelOverridePatch]) {
  assert.match(overridePatch.content, /codexfast-ultrafast-model-tiers/);
  assert.ok(overridePatch.patchedLabels.includes(ultrafastLabel));
  const modelOverrideSelector = new Function(
    "Jv", "e", "t", "n", "c", "l", "i",
    `return (${overridePatch.content.split("select:")[1]});`,
  )((fields) => fields, [], "personalAccessToken", { availableModels: new Set(), defaultModel: "gpt-5.5", useHiddenModels: false }, new Set(["medium"]), false, false);
  const overriddenModel = modelOverrideSelector({ data: modelOverrideCatalog }).models.find((model) => model.model === "gpt-5.6");
  assert.ok(overriddenModel);
  assert.equal(overriddenModel.serviceTiers.filter((tier) => tier.id === "ultrafast").length, 1);
}
assert.equal(modelOverrideCatalog[0].model, "gpt-5.5");
assert.equal(modelOverrideCatalog[0].serviceTiers.length, 1);

// Exercise the single-file native catalog helpers without executing its launcher main().
const launcherSource = fs.readFileSync(launcher, "utf8");
const nativeHelperSources = ["tierName", "addUltrafast", "shellQuote", "cliWrapperSource"].map((name) => {
  const source = launcherSource.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(source, `launcher should contain its native ${name} helper`);
  return source;
});
const nativeHelpers = new Function(
  `${nativeHelperSources.join("\n")}\nreturn { addUltrafast, shellQuote, cliWrapperSource };`,
)();
const nativeFast = Object.freeze({ id: "priority", name: "Fast", description: "Original fast tier", extra: "keep" });
const nativeUltra = Object.freeze({ id: "ultrafast", name: "Existing Ultrafast", description: "Keep" });
const nativeModel = Object.freeze({
  slug: "fixture-fast-model",
  display_name: "Fixture fast model",
  description: "Synthetic native ModelInfo for an isolated catalog test",
  supported_reasoning_levels: Object.freeze([{ effort: "low", description: "Low" }]),
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  support_verbosity: true,
  truncation_policy: Object.freeze({ mode: "tokens", limit: 10_000 }),
  experimental_supported_tools: Object.freeze(["fixture-tool"]),
  context_window: 100_000,
  model_messages: Object.freeze({ instructions_template: "Fixture metadata must be preserved." }),
  service_tiers: Object.freeze([nativeFast]),
});
const standardOnlyNative = Object.freeze({ ...nativeModel, slug: "fixture-standard", service_tiers: Object.freeze([]) });
const existingUltraNative = Object.freeze({ ...nativeModel, slug: "fixture-ultra", service_tiers: Object.freeze([nativeFast, nativeUltra]) });
const nativeCatalog = Object.freeze({ models: Object.freeze([nativeModel, standardOnlyNative, existingUltraNative]), extra_metadata: "keep" });
const extendedNative = nativeHelpers.addUltrafast(nativeCatalog);
assert.deepEqual(extendedNative.patchedModels, [nativeModel.slug]);
assert.equal(extendedNative.catalog.extra_metadata, nativeCatalog.extra_metadata);
assert.strictEqual(extendedNative.catalog.models[1], standardOnlyNative);
assert.strictEqual(extendedNative.catalog.models[2], existingUltraNative);
assert.strictEqual(extendedNative.catalog.models[0].service_tiers[0], nativeFast);
assert.deepEqual(extendedNative.catalog.models[0].service_tiers[1], { id: "ultrafast", name: "Ultrafast", description: "" });
assert.equal(nativeModel.service_tiers.length, 1, "native source metadata must remain unchanged");
for (const key of Object.keys(nativeModel).filter((key) => key !== "service_tiers")) {
  assert.strictEqual(extendedNative.catalog.models[0][key], nativeModel[key], `native metadata ${key} must be preserved`);
}
assert.deepEqual(nativeHelpers.addUltrafast(extendedNative.catalog).patchedModels, []);
assert.equal(nativeHelpers.shellQuote("a'b"), "'a'\\''b'");
assert.equal(nativeHelpers.shellQuote("$VAR `cmd` \\\""), "'$VAR `cmd` \\\"'");
const quotedCliPath = "/tmp/codex's CLI";
const quotedCatalogPath = "/tmp/catalog's $VAR `tick` \\\".json";
const nativeWrapper = nativeHelpers.cliWrapperSource(quotedCliPath, quotedCatalogPath);
assert.ok(nativeWrapper.includes("CODEX_CLI_PATH='/tmp/codex'\\''s CLI'\nexport CODEX_CLI_PATH"));
assert.ok(nativeWrapper.includes(`exec "$CODEX_CLI_PATH" "$@" -c ${nativeHelpers.shellQuote(`model_catalog_json=${JSON.stringify(quotedCatalogPath)}`)}`));
assert.ok(nativeWrapper.endsWith('exec "$CODEX_CLI_PATH" "$@"\n'));

console.log("codexfast-launcher tests passed");

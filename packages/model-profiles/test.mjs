import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import activate, { findProfile, getProfilesPath, parseCommandArgs, readProfiles, writeProfiles } from "./mods/index.ts";

async function tempMemoryDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "letta-model-profiles-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  return dir;
}

function createHarness() {
  const tools = new Map();
  const commands = new Map();
  const warnings = [];
  const dispose = activate({
    capabilities: { tools: true, commands: true },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.id, definition);
        return () => commands.delete(definition.id);
      },
    },
    diagnostics: {
      report({ message }) {
        warnings.push(message);
      },
    },
  });
  return { tools, commands, warnings, dispose };
}

function createContext(memoryDir, overrides = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      memfs: { enabled: true, memoryDir },
      model: { id: "anthropic/claude-opus-4-8", reasoningEffort: "high" },
      contextWindow: { size: 200000 },
      agent: { id: "agent-1" },
      conversation: {
        id: "conv-1",
        async updateLlmConfig(options) {
          calls.push(options);
        },
      },
      ...overrides,
    },
  };
}

function runTool(harness, name, ctx, args = {}) {
  return harness.tools.get(name).run({ ...ctx, args });
}

function runCommand(harness, ctx, args) {
  const argv = args.trim().split(/\s+/).filter(Boolean);
  return harness.commands.get("model-profile").run({ ...ctx, args, argv });
}

test("getProfilesPath prefers ctx.memfs.memoryDir, then MEMORY_DIR, then ~/.letta", async (t) => {
  const memory = await tempMemoryDir(t);
  const previous = process.env.MEMORY_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = previous;
  });

  assert.equal(getProfilesPath({ memfs: { memoryDir: memory } }), join(memory, "mods", "model-profiles.json"));

  process.env.MEMORY_DIR = memory;
  assert.equal(getProfilesPath({}), join(memory, "mods", "model-profiles.json"));

  delete process.env.MEMORY_DIR;
  assert.match(getProfilesPath({}), /\.letta[\\/]mods[\\/]model-profiles\.json$/);
});

test("getProfilesPath keeps using a legacy root-level file until a mods/ file exists", async (t) => {
  const memory = await tempMemoryDir(t);
  const ctx = { memfs: { memoryDir: memory } };
  await writeFile(join(memory, "model-profiles.json"), JSON.stringify({ version: 1, profiles: {} }));
  assert.equal(getProfilesPath(ctx), join(memory, "model-profiles.json"));

  await mkdir(join(memory, "mods"));
  await writeFile(join(memory, "mods", "model-profiles.json"), JSON.stringify({ version: 1, profiles: {} }));
  assert.equal(getProfilesPath(ctx), join(memory, "mods", "model-profiles.json"));
});

test("writeProfiles round-trips and leaves no temp file behind", async (t) => {
  const memory = await tempMemoryDir(t);
  const ctx = { memfs: { memoryDir: memory } };
  const state = { version: 1, profiles: { "xai/grok-4-6": { contextWindow: 250000, reasoningEffort: "xhigh", label: "Grok 4.6" } } };
  writeProfiles(ctx, state);
  assert.deepEqual(readProfiles(ctx), state);
  assert.deepEqual(await readdir(join(memory, "mods")), ["model-profiles.json"]);
});

test("readProfiles moves an unreadable file aside instead of discarding it", async (t) => {
  const memory = await tempMemoryDir(t);
  const harness = createHarness();
  t.after(harness.dispose);
  const ctx = { memfs: { memoryDir: memory } };
  await mkdir(join(memory, "mods"));
  await writeFile(join(memory, "mods", "model-profiles.json"), "{ not json");

  assert.deepEqual(readProfiles(ctx), { version: 1, profiles: {} });
  const files = await readdir(join(memory, "mods"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^model-profiles\.json\.corrupt-\d+$/);
  assert.equal(await readFile(join(memory, "mods", files[0]), "utf8"), "{ not json");
  assert.equal(harness.warnings.length, 1);
  assert.match(harness.warnings[0], /moved to/);
});

test("readProfiles drops malformed entries and tolerates profiles: null", async (t) => {
  const memory = await tempMemoryDir(t);
  const ctx = { memfs: { memoryDir: memory } };
  await mkdir(join(memory, "mods"));
  await writeFile(
    join(memory, "mods", "model-profiles.json"),
    JSON.stringify({
      version: 1,
      profiles: {
        good: { contextWindow: 1000, reasoningEffort: "bogus", label: "  Good  " },
        missingWindow: { label: "x" },
        negative: { contextWindow: -5 },
      },
    }),
  );
  assert.deepEqual(readProfiles(ctx), { version: 1, profiles: { good: { contextWindow: 1000, label: "Good" } } });

  await writeFile(join(memory, "mods", "model-profiles.json"), JSON.stringify({ profiles: null }));
  assert.deepEqual(readProfiles(ctx), { version: 1, profiles: {} });
  assert.ok((await readdir(join(memory, "mods"))).some((name) => name.includes(".corrupt-")));
});

test("findProfile matches by exact handle, case-insensitive handle, or label", () => {
  const state = { version: 1, profiles: { "xai/grok-4-6": { contextWindow: 1, label: "Grok 4.6" } } };
  assert.equal(findProfile(state, "xai/grok-4-6")?.handle, "xai/grok-4-6");
  assert.equal(findProfile(state, "XAI/GROK-4-6")?.handle, "xai/grok-4-6");
  assert.equal(findProfile(state, "grok 4.6")?.handle, "xai/grok-4-6");
  assert.equal(findProfile(state, "grok"), null);
  assert.equal(findProfile(state, "   "), null);
});

test("parseCommandArgs accepts scope flags anywhere and keeps multi-word positionals", () => {
  assert.deepEqual(parseCommandArgs([]), { sub: "list", positional: [], scope: "conversation", error: undefined });
  assert.deepEqual(parseCommandArgs(["switch", "Grok", "4.6", "--scope", "agent"]), {
    sub: "switch",
    positional: ["Grok", "4.6"],
    scope: "agent",
    error: undefined,
  });
  assert.equal(parseCommandArgs(["switch", "--scope=agent", "x"]).scope, "agent");
  assert.equal(parseCommandArgs(["--agent", "switch", "x"]).scope, "agent");
  assert.match(parseCommandArgs(["switch", "x", "--scope", "global"]).error, /Unknown scope/);
  assert.match(parseCommandArgs(["switch", "x", "--bogus"]).error, /Unknown flag/);
});

test("registers four snake_case tools with mutators marked not parallel-safe", (t) => {
  const harness = createHarness();
  t.after(harness.dispose);
  assert.deepEqual([...harness.tools.keys()].sort(), [
    "delete_model_profile",
    "list_model_profiles",
    "set_model_profile",
    "switch_model_profile",
  ]);
  assert.equal(harness.tools.get("list_model_profiles").parallelSafe, true);
  for (const name of ["set_model_profile", "switch_model_profile", "delete_model_profile"]) {
    assert.equal(harness.tools.get(name).parallelSafe, false, name);
    assert.equal(harness.tools.get(name).requiresApproval, false, name);
  }
  assert.deepEqual([...harness.commands.keys()], ["model-profile"]);
  harness.dispose();
  assert.equal(harness.tools.size, 0);
  assert.equal(harness.commands.size, 0);
});

test("set_model_profile validates input and persists every reasoning tier", async (t) => {
  const memory = await tempMemoryDir(t);
  const harness = createHarness();
  t.after(harness.dispose);
  const { ctx } = createContext(memory);

  assert.equal(runTool(harness, "set_model_profile", ctx, { model: " ", context_window: 1 }).status, "error");
  assert.equal(runTool(harness, "set_model_profile", ctx, { model: "m", context_window: 0 }).status, "error");
  assert.equal(runTool(harness, "set_model_profile", ctx, { model: "m", context_window: 1, reasoning_effort: "turbo" }).status, "error");

  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const result = runTool(harness, "set_model_profile", ctx, { model: `m/${effort}`, context_window: 1000.7, reasoning_effort: effort });
    assert.equal(result.status, "success", effort);
    assert.equal(JSON.parse(result.output).profile.reasoningEffort, effort);
  }
  const stored = readProfiles(ctx).profiles;
  assert.equal(Object.keys(stored).length, 7);
  assert.equal(stored["m/xhigh"].contextWindow, 1000);
  assert.match(stored["m/xhigh"].updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("switch_model_profile applies the saved profile and reports the applied context window", async (t) => {
  const memory = await tempMemoryDir(t);
  const harness = createHarness();
  t.after(harness.dispose);
  const { ctx, calls } = createContext(memory);
  runTool(harness, "set_model_profile", ctx, { model: "xai/grok-4-6", context_window: 250000, reasoning_effort: "xhigh", label: "Grok 4.6" });

  const byLabel = await runTool(harness, "switch_model_profile", ctx, { model: "grok 4.6" });
  assert.equal(byLabel.status, "success");
  assert.deepEqual(calls.at(-1), { model: "xai/grok-4-6", scope: "conversation", contextWindow: 250000, reasoningEffort: "xhigh" });
  const parsed = JSON.parse(byLabel.output);
  assert.match(parsed.message, /250,000/);
  assert.doesNotMatch(parsed.message, /No saved profile/);
  assert.equal(parsed.applied.context_window, 250000);

  await runTool(harness, "switch_model_profile", ctx, { model: "xai/grok-4-6", scope: "agent", context_window: 128000, reasoning_effort: "low" });
  assert.deepEqual(calls.at(-1), { model: "xai/grok-4-6", scope: "agent", contextWindow: 128000, reasoningEffort: "low" });

  const unknown = await runTool(harness, "switch_model_profile", ctx, { model: "openai/gpt-5.5" });
  assert.equal(unknown.status, "success");
  assert.deepEqual(calls.at(-1), { model: "openai/gpt-5.5", scope: "conversation" });
  assert.match(JSON.parse(unknown.output).message, /provider default/);
  assert.match(JSON.parse(unknown.output).message, /No saved profile/);

  assert.equal((await runTool(harness, "switch_model_profile", ctx, { model: "x", reasoning_effort: "turbo" })).status, "error");
});

test("switch_model_profile reports backend failures as tool errors", async (t) => {
  const memory = await tempMemoryDir(t);
  const harness = createHarness();
  t.after(harness.dispose);
  const failing = createContext(memory, {
    conversation: {
      id: "conv-1",
      async updateLlmConfig() {
        throw new Error("model not available");
      },
    },
  });
  const result = await runTool(harness, "switch_model_profile", failing.ctx, { model: "x" });
  assert.equal(result.status, "error");
  assert.match(JSON.parse(result.output).error, /model not available/);

  const missing = createContext(memory, { conversation: { id: "conv-1" } });
  const noApi = await runTool(harness, "switch_model_profile", missing.ctx, { model: "x" });
  assert.equal(noApi.status, "error");
  assert.match(JSON.parse(noApi.output).error, /updateLlmConfig/);
});

test("list_model_profiles and delete_model_profile", async (t) => {
  const memory = await tempMemoryDir(t);
  const harness = createHarness();
  t.after(harness.dispose);
  const { ctx } = createContext(memory);
  runTool(harness, "set_model_profile", ctx, { model: "a/b", context_window: 10, label: "AB" });

  const listed = JSON.parse(runTool(harness, "list_model_profiles", ctx).output);
  assert.equal(listed.storage_path, join(memory, "mods", "model-profiles.json"));
  assert.deepEqual(listed.current, {
    model: "anthropic/claude-opus-4-8",
    context_window: 200000,
    reasoning_effort: "high",
    conversation_id: "conv-1",
    agent_id: "agent-1",
  });
  assert.equal(listed.profiles["a/b"].contextWindow, 10);

  assert.equal(runTool(harness, "delete_model_profile", ctx, { model: "nope" }).status, "error");
  assert.equal(runTool(harness, "delete_model_profile", ctx, { model: "ab" }).status, "success");
  assert.deepEqual(readProfiles(ctx).profiles, {});
});

test("/model-profile command round-trip with multi-word labels and scope flags", async (t) => {
  const memory = await tempMemoryDir(t);
  const harness = createHarness();
  t.after(harness.dispose);
  const { ctx, calls } = createContext(memory);

  const empty = await runCommand(harness, ctx, "");
  assert.equal(empty.success, true);
  assert.match(empty.output, /no profiles saved yet/);
  assert.match(empty.output, /Current: anthropic\/claude-opus-4-8 \(context: 200,000 tokens, reasoning: high\)/);

  const set = await runCommand(harness, ctx, "set xai/grok-4-6 250000 xhigh Grok 4.6");
  assert.equal(set.success, true);
  assert.deepEqual(readProfiles(ctx).profiles["xai/grok-4-6"].label, "Grok 4.6");
  assert.equal(readProfiles(ctx).profiles["xai/grok-4-6"].reasoningEffort, "xhigh");

  const noReasoning = await runCommand(harness, ctx, "set a/b 1000 My Label");
  assert.equal(noReasoning.success, true);
  assert.equal(readProfiles(ctx).profiles["a/b"].reasoningEffort, undefined);
  assert.equal(readProfiles(ctx).profiles["a/b"].label, "My Label");

  assert.equal((await runCommand(harness, ctx, "set a/b notanumber")).success, false);

  const list = await runCommand(harness, ctx, "list");
  assert.match(list.output, /xai\/grok-4-6 \(Grok 4.6\): 250,000 tokens \[reasoning: xhigh\]/);

  const switched = await runCommand(harness, ctx, "switch Grok 4.6 --scope agent");
  assert.equal(switched.success, true);
  assert.deepEqual(calls.at(-1), { model: "xai/grok-4-6", scope: "agent", contextWindow: 250000, reasoningEffort: "xhigh" });
  assert.match(switched.output, /250,000 tokens.*scope: agent/);

  const equalsFlag = await runCommand(harness, ctx, "switch --scope=agent a/b");
  assert.equal(equalsFlag.success, true);
  assert.equal(calls.at(-1).scope, "agent");

  const badScope = await runCommand(harness, ctx, "switch a/b --scope global");
  assert.equal(badScope.success, false);
  assert.match(badScope.output, /Unknown scope/);

  const unknownModel = await runCommand(harness, ctx, "switch openai/gpt-5.5");
  assert.equal(unknownModel.success, true);
  assert.match(unknownModel.output, /No saved profile/);

  const removed = await runCommand(harness, ctx, "remove Grok 4.6");
  assert.equal(removed.success, true);
  assert.equal(readProfiles(ctx).profiles["xai/grok-4-6"], undefined);
  assert.equal((await runCommand(harness, ctx, "remove Grok 4.6")).success, false);
  assert.equal((await runCommand(harness, ctx, "bogus")).success, false);
});

test("command handler falls back to splitting ctx.args when argv is absent", async (t) => {
  const memory = await tempMemoryDir(t);
  const harness = createHarness();
  t.after(harness.dispose);
  const { ctx } = createContext(memory);
  const result = await harness.commands.get("model-profile").run({ ...ctx, args: "set a/b 42 Some Label" });
  assert.equal(result.success, true);
  assert.equal(readProfiles(ctx).profiles["a/b"].label, "Some Label");
});

// ---------------------------------------------------------------------------
// Profile enforcement against the live conversation record.
//
// These cover the two failures that made profiles unreliable in practice:
//   1. `updateLlmConfig` cannot carry max_output_tokens, so a profile only ever
//      restored half its settings.
//   2. Nothing re-applied a profile after a model change made outside this mod
//      (the UI picker resets the conversation to catalog placeholders), and in
//      listener mode `letta.client` is a truthy proxy whose calls throw.
// ---------------------------------------------------------------------------

function createEnforcingHarness({ client = null } = {}) {
  const events = new Map();
  const warnings = [];
  const dispose = activate({
    capabilities: { tools: true, commands: true, events: { lifecycle: true, turns: true } },
    tools: { register: () => () => {} },
    commands: { register: () => () => {} },
    events: {
      on(name, handler) {
        events.set(name, handler);
        return () => events.delete(name);
      },
    },
    diagnostics: { report({ message }) { warnings.push(message); } },
    client,
  });
  return { events, warnings, dispose };
}

/** A conversation store behind a fake REST endpoint, shaped like the real API. */
function fakeConversations(initial) {
  const store = new Map(Object.entries(initial).map(([id, value]) => [id, { ...value }]));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const id = decodeURIComponent(String(url).split("/v1/conversations/")[1] ?? "");
    const method = init.method ?? "GET";
    calls.push(`${method} ${id}`);
    const record = store.get(id);
    if (!record) return new Response("not found", { status: 404 });
    if (method === "PATCH") {
      const body = JSON.parse(init.body ?? "{}");
      if (typeof body.context_window_limit === "number") record.context_window_limit = body.context_window_limit;
      if (body.model_settings) record.model_settings = { ...body.model_settings };
      if (typeof body.model === "string") record.model = body.model;
    }
    return new Response(JSON.stringify(record), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { store, calls, fetchImpl };
}

async function withRestServer(t, conversations) {
  const previous = { fetch: globalThis.fetch, base: process.env.LETTA_BASE_URL, key: process.env.LETTA_API_KEY };
  globalThis.fetch = conversations.fetchImpl;
  process.env.LETTA_BASE_URL = "https://api.example.test";
  process.env.LETTA_API_KEY = "test-key";
  t.after(() => {
    globalThis.fetch = previous.fetch;
    for (const [name, value] of [["LETTA_BASE_URL", previous.base], ["LETTA_API_KEY", previous.key]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

async function seedProfile(memoryDir, handle, profile) {
  writeProfiles({ memfs: { memoryDir } }, { version: 1, profiles: { [handle]: profile } });
}

/** Seed several profiles at once; writeProfiles replaces the whole file. */
async function seedProfiles(memoryDir, profiles) {
  writeProfiles({ memfs: { memoryDir } }, { version: 1, profiles });
}

test("turn_start restores both limits over REST when letta.client is a throwing proxy", async (t) => {
  const memory = await tempMemoryDir(t);
  const conversations = fakeConversations({
    "conv-listener": {
      id: "conv-listener",
      model: "lc_opencode_go/deepseek-v4.1-flash",
      context_window_limit: 128000,
      model_settings: { provider_type: "opencode_go", parallel_tool_calls: true, max_output_tokens: 4096 },
    },
  });
  await withRestServer(t, conversations);
  await seedProfile(memory, "lc_opencode_go/deepseek-v4.1-flash", { contextWindow: 1000000, maxOutputTokens: 384000 });

  // Listener shape: truthy proxy, every call throws.
  const throwingClient = {
    conversations: {
      retrieve: async () => { throw new Error("letta.client is not available in listener mods"); },
      update: async () => { throw new Error("letta.client is not available in listener mods"); },
    },
  };
  const harness = createEnforcingHarness({ client: throwingClient });
  t.after(harness.dispose);

  await harness.events.get("turn_start")({ conversationId: "conv-listener" }, { memfs: { memoryDir: memory } });

  const record = conversations.store.get("conv-listener");
  assert.equal(record.context_window_limit, 1000000);
  assert.equal(record.model_settings.max_output_tokens, 384000);
  // Unrelated settings must survive: the API replaces model_settings wholesale.
  assert.equal(record.model_settings.provider_type, "opencode_go");
  assert.equal(record.model_settings.parallel_tool_calls, true);
});

test("a later model switch is re-enforced (no one-shot latch)", async (t) => {
  const memory = await tempMemoryDir(t);
  const conversations = fakeConversations({
    "conv-switch": {
      id: "conv-switch",
      model: "lc_opencode_go/deepseek-v4.1-flash",
      context_window_limit: 128000,
      model_settings: { provider_type: "opencode_go", max_output_tokens: 4096 },
    },
  });
  await withRestServer(t, conversations);
  await seedProfiles(memory, {
    "lc_opencode_go/deepseek-v4.1-flash": { contextWindow: 1000000, maxOutputTokens: 384000 },
    "lc_opencode_go/kimi-k3.1-pro": { contextWindow: 1048576, maxOutputTokens: 131072 },
  });

  const harness = createEnforcingHarness();
  t.after(harness.dispose);
  const ctx = { memfs: { memoryDir: memory } };
  const turnStart = harness.events.get("turn_start");

  await turnStart({ conversationId: "conv-switch" }, ctx);
  assert.equal(conversations.store.get("conv-switch").context_window_limit, 1000000);

  // Simulate the UI picker: new model, catalog placeholders.
  const record = conversations.store.get("conv-switch");
  record.model = "lc_opencode_go/kimi-k3.1-pro";
  record.context_window_limit = 128000;
  record.model_settings = { provider_type: "opencode_go", max_output_tokens: 4096 };

  await turnStart({ conversationId: "conv-switch" }, ctx);
  assert.equal(record.context_window_limit, 1048576);
  assert.equal(record.model_settings.max_output_tokens, 131072);
});

test("an already-correct conversation is read but not rewritten", async (t) => {
  const memory = await tempMemoryDir(t);
  const conversations = fakeConversations({
    "conv-ok": {
      id: "conv-ok",
      model: "anthropic/claude-opus-4-8",
      context_window_limit: 250000,
      model_settings: { provider_type: "anthropic", max_output_tokens: 32000 },
    },
  });
  await withRestServer(t, conversations);
  await seedProfile(memory, "anthropic/claude-opus-4-8", { contextWindow: 250000, maxOutputTokens: 32000 });

  const harness = createEnforcingHarness();
  t.after(harness.dispose);
  conversations.calls.length = 0;
  await harness.events.get("turn_start")({ conversationId: "conv-ok" }, { memfs: { memoryDir: memory } });

  assert.deepEqual(conversations.calls, ["GET conv-ok"]);
  assert.equal(harness.warnings.length, 0);
});

test("a model without a profile is left alone", async (t) => {
  const memory = await tempMemoryDir(t);
  const conversations = fakeConversations({
    "conv-other": { id: "conv-other", model: "nobody/unknown", context_window_limit: 64000, model_settings: {} },
  });
  await withRestServer(t, conversations);
  await seedProfile(memory, "anthropic/claude-opus-4-8", { contextWindow: 250000 });

  const harness = createEnforcingHarness();
  t.after(harness.dispose);
  await harness.events.get("turn_start")({ conversationId: "conv-other" }, { memfs: { memoryDir: memory } });
  assert.equal(conversations.store.get("conv-other").context_window_limit, 64000);
});

test("switching a model applies max output tokens through the conversation API", async (t) => {
  const memory = await tempMemoryDir(t);
  const conversations = fakeConversations({
    "conv-1": {
      id: "conv-1",
      model: "anthropic/claude-opus-4-8",
      context_window_limit: 200000,
      model_settings: { provider_type: "anthropic", parallel_tool_calls: true, max_output_tokens: 8192 },
    },
  });
  await withRestServer(t, conversations);
  await seedProfile(memory, "xai/grok-4-6", { contextWindow: 250000, maxOutputTokens: 32000 });

  const harness = createHarness();
  t.after(harness.dispose);
  const { ctx, calls } = createContext(memory);
  const result = await runCommand(harness, ctx, "switch xai/grok-4-6");

  assert.equal(result.success, true);
  assert.equal(calls[0].model, "xai/grok-4-6");
  assert.equal(calls[0].contextWindow, 250000);
  const record = conversations.store.get("conv-1");
  assert.equal(record.model_settings.max_output_tokens, 32000);
  assert.equal(record.model_settings.parallel_tool_calls, true);
});

test("a missing transport is reported instead of failing silently", async (t) => {
  const memory = await tempMemoryDir(t);
  const previous = { base: process.env.LETTA_BASE_URL, key: process.env.LETTA_API_KEY };
  delete process.env.LETTA_BASE_URL;
  delete process.env.LETTA_API_KEY;
  t.after(() => {
    if (previous.base !== undefined) process.env.LETTA_BASE_URL = previous.base;
    if (previous.key !== undefined) process.env.LETTA_API_KEY = previous.key;
  });
  await seedProfile(memory, "anthropic/claude-opus-4-8", { contextWindow: 250000, maxOutputTokens: 32000 });

  const harness = createEnforcingHarness();
  t.after(harness.dispose);
  harness.warnings.length = 0;
  await harness.events.get("turn_start")({ conversationId: "conv-1" }, { memfs: { memoryDir: memory } });

  assert.ok(harness.warnings.length > 0);
  assert.match(harness.warnings[0], /could not read/);
});

test("--max-output is parsed and saved with the profile", async (t) => {
  const memory = await tempMemoryDir(t);
  const harness = createHarness();
  t.after(harness.dispose);
  const { ctx } = createContext(memory);

  assert.equal(parseCommandArgs(["set", "a/b", "1000", "--max-output", "9000"]).maxOutputTokens, 9000);
  assert.equal(parseCommandArgs(["set", "a/b", "1000"]).maxOutputTokens, undefined);
  assert.match(parseCommandArgs(["set", "a/b", "1000", "--max-output", "nope"]).error, /positive integer/);

  const result = await runCommand(harness, ctx, "set a/b 1000 --max-output 9000 A B");
  assert.equal(result.success, true);
  const saved = readProfiles(ctx).profiles["a/b"];
  assert.equal(saved.maxOutputTokens, 9000);
  assert.equal(saved.label, "A B");

  const listed = await runCommand(harness, ctx, "list");
  assert.match(listed.output, /max output: 9,000/);
});

---
name: "@letta-ai/model-profiles"
description: "Remember a context window limit, max output tokens, and reasoning effort per model and enforce them on switch and on every turn."
---

# Model profiles mod semantics

## When to use

Use this mod when a model should always run with a saved context window limit, max output tokens, and reasoning effort, instead of leaving the user to set them again after every switch. It matters most for models whose catalog entry carries placeholder limits, where a switch silently reverts the conversation.

## Behavioral contract

- A profile is keyed by model handle and holds `contextWindow` (positive integer, tokens), optional `maxOutputTokens` (positive integer, tokens), optional `reasoningEffort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), optional `label`, and `updatedAt`.
- `switch_model_profile` and `/model-profile switch` resolve the argument as an exact handle, then a case-insensitive handle, then a case-insensitive label. Explicit `context_window` / `max_output_tokens` / `reasoning_effort` arguments override the saved profile.
- A switch calls `ctx.conversation.updateLlmConfig({ model, contextWindow, reasoningEffort, scope })`, then writes `max_output_tokens` separately through the conversation API. `updateLlmConfig` cannot express that field, so it is not available on that single call. Fields that are neither saved nor overridden are omitted, so the runtime keeps or defaults them.
- `scope: "conversation"` (default) changes only the active conversation. `scope: "agent"` changes the agent default, and skips the separate max-output write, which is conversation-scoped.
- Changes apply on the next turn.

## Enforcement on conversation start and every turn

- On `conversation_open` (where lifecycle events exist) and on every `turn_start`, the mod reads the active conversation and applies the profile for its model when the live values differ.
- Only the diverging fields are written. `model_settings` is replaced wholesale by the API, so the write carries the conversation's existing settings with only `max_output_tokens` overridden. Without that, `provider_type`, `parallel_tool_calls`, reasoning, and other settings would be dropped.
- A model with no saved profile is left untouched. A conversation whose values already match is read once and not written, which is the common case.
- There is deliberately no per-conversation "already applied" latch: `ctx.model.id` resolves from the agent record in listener mode, not from the conversation, so a later UI model change is only observable from the conversation record itself.

## Transport

- `letta.client` is captured at activation, because event contexts do not carry a client.
- In listener-hosted sessions that value is a truthy lazy proxy whose calls throw, so a non-null client is not evidence that it works. Every read and write tries the SDK and falls back to authenticated REST at `${LETTA_BASE_URL}/v1/conversations/{id}` using `LETTA_API_KEY`, both of which the listener process carries.
- With no SDK and no REST credentials the mod reports a warning diagnostic rather than failing silently.

## Storage and recovery

- File: `ctx.memfs.memoryDir/mods/model-profiles.json`, falling back to `MEMORY_DIR`, then `~/.letta/mods/model-profiles.json`. An existing root-level `model-profiles.json` in the memory directory keeps being used.
- Writes are temp-file plus rename. The mod never commits or pushes.
- An unreadable or malformed file is moved to `model-profiles.json.corrupt-<timestamp>` and a warning diagnostic is reported. Malformed individual entries are skipped on read and dropped on the next write.

## Tools

- `list_model_profiles` (parallel-safe)
- `set_model_profile` (`model`, `context_window`, `max_output_tokens?`, `reasoning_effort?`, `label?`)
- `switch_model_profile` (`model`, `scope?`, `context_window?`, `max_output_tokens?`, `reasoning_effort?`)
- `delete_model_profile` (`model`)

Tools that write or switch are registered with `parallelSafe: false` and do not require approval. Validation failures and backend errors are returned as tool results with `status: "error"`, not thrown.

## Command

`/model-profile [list|set|switch|remove]`. Flags `--scope <conversation|agent>`, `--scope=<value>`, `--agent`, `--conversation`, and `--max-output <tokens>` may appear anywhere. Remaining tokens are positional, so labels with spaces work in `set`, `switch`, and `remove`.

## Adaptation notes

- Use `ctx.memfs.memoryDir` and `ctx.conversation.updateLlmConfig`; do not derive private Letta Code paths or import internal modules.
- Keep the reasoning tier list in sync with `ModelReasoningEffort` in Letta Code.
- Guard the event registrations on `letta.capabilities.events.lifecycle` and `.turns` separately; hosts expose different subsets.

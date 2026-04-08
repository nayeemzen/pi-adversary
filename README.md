# pi-adversary

A structured **advocate/adversary debate** chat mode for the
[pi coding agent](https://github.com/badlogic/pi-mono). Every user prompt
runs through a three-role loop — an advocate produces the best answer it
can, an adversary stress-tests it in isolation, and the loop iterates until
the adversary has no remaining substantive objections.

It is a drop-in pi extension. No new binary, no new service. Just run
`/adversarial on <advocate-model> <adversary-model>` and keep chatting.

## Why

Single-shot LLM answers are confident, fluent, and often wrong in ways
that are hard to catch by asking the same model to "double check." The
failure mode is the model re-deriving the same flawed reasoning because
it is still in the same context.

`pi-adversary` breaks that by running two independent sessions:

- **The advocate** sees only the user prompt plus critiques forwarded to
  it as peer review. It revises in place.
- **The adversary** sees only the advocate's latest answer and the
  original user prompt. It critiques using a fixed priority list
  (intent → hidden assumptions → strongest counterargument → failure
  modes → better approaches → contradictions).
- **The orchestrator** is pure code. It routes messages, detects
  convergence, and emits the final synthesis. It never generates
  substantive content.

The two roles can run on different models. Putting a large reasoning
model on adversary duty against a fast model on advocate duty is a
cheap way to buy a second opinion without paying for two full debates
on the bigger model.

## Features

- **Two real isolated sessions.** Each role has its own `Message[]`
  history, its own system prompt, its own LLM call. Cross-role data
  flows only as extracted plain text, never as `AssistantMessage`
  objects. Thinking blocks, tool calls, and message metadata stay
  inside the originating role. See
  [Context Isolation](#context-isolation) for the empirical proof.
- **Live streaming.** Each turn streams into a widget above the editor
  with a tail preview, plus a char count in the footer. The chat
  scrollback gets the committed final text per turn.
- **Full markdown rendering.** Debate turns render through pi's
  built-in `Markdown` component — headings, bold, bullets, tables,
  syntax-highlighted code blocks, the works.
- **Session persistence.** Mode state and full debate transcripts
  persist into the pi session log. Mode is restored on
  `/resume` and re-open.
- **Convergence detection.** Auto mode stops as soon as the adversary
  signals `[CONVERGED]`. Manual mode prompts you between turns.
  Strict mode runs to `max_turns` regardless.
- **Three synthesis styles.** `merged` (clean final answer),
  `annotated` (final answer + listed critiques), `diff` (initial
  vs final side-by-side).
- **Per-role reasoning level.** Run a fast advocate at
  `thinking=off` against an adversary at `thinking=high` to buy a
  rigorous second opinion without paying for two slow turns.
  Automatically clamps to `off` on non-reasoning models.
- **Configurable via CLI args or interactive setup.**
- **Cancellable.** Any second user message mid-debate aborts the
  in-flight debate.

## Demo

```text
> /adversarial on anthropic/claude-haiku-4-5 anthropic/claude-opus-4-5 min=2 max=4
[Adversarial] Adversarial mode enabled.

- Advocate:    anthropic/claude-haiku-4-5
- Adversary:   anthropic/claude-opus-4-5
- Min turns:   2
- Max turns:   4
- Convergence: auto
- Synthesis:   merged

> Are hot dogs sandwiches? Defend with rigor.

[You] Are hot dogs sandwiches? Defend with rigor.

[Advocate T1] anthropic/claude-haiku-4-5
# Hot Dogs Are Not Sandwiches
...

[Adversary T1] anthropic/claude-opus-4-5
## Structural Critique
1. **User intent vs. literal question** — the user asked you to
   "defend with rigor" but you hedged...
2. **Hidden assumption** — you assume "sandwich" has a determinate
   definition, which is the core disputed point...
...

[Advocate T2] anthropic/claude-haiku-4-5
# Response to the critique
The critique is largely right. I concede 5 of 7 points and defend
2 with revised framing...
...

[Adversary T2] anthropic/claude-opus-4-5
[CONVERGED]
The advocate has acknowledged the definitional frame, committed
to a specific camp with explicit regulatory grounding, and the
remaining disagreement is genuinely semantic rather than factual.

[Synthesis]
# Hot Dogs Are Not Sandwiches (Revised)
...clean final answer ready to use...
```

During each turn, a widget above the editor shows the streaming text
tail with a live char count so you can watch the argument develop.

## Install

### Try it once without installing

```bash
pi -e git:github.com/nayeemzen/pi-adversary
```

This installs the package into a temp directory for a single run.
Nothing is written to your settings.

### Install globally

```bash
pi install git:github.com/nayeemzen/pi-adversary
```

Adds the package to `~/.pi/agent/settings.json`. Available in every
pi session on your machine.

### Install into a single project

```bash
cd my-project
pi install -l git:github.com/nayeemzen/pi-adversary
```

Adds it to `.pi/settings.json` — shareable with your team via git.
Other contributors who run pi in the project will install
automatically.

### Install from source

```bash
git clone https://github.com/nayeemzen/pi-adversary.git ~/hatchery/pi-adversary
pi install ~/hatchery/pi-adversary
```

Or drop just `extensions/adversarial.ts` into `~/.pi/agent/extensions/`
for a fully local install with no package machinery.

## Usage

### Commands

```text
/adversarial                            Interactive setup (dialog prompts)
/adversarial on                         Same as above
/adversarial on <advocate> <adversary> [k=v ...]
                                        Non-interactive setup
/adversarial off                        Exit debate mode
/adversarial status                     Show current config
/adversarial help                       Show inline help
```

Model spec format: `provider/model-id`, e.g.
`anthropic/claude-sonnet-4-5`, `openai/gpt-5.3`, `google/gemini-2.5-pro`.
Any model pi can call works, as long as the required auth is
configured (`pi login` or env vars).

### Parameters

| Key                  | Default  | Values                                                | Description                                                                                                                            |
| -------------------- | -------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `min`                | `3`      | 1–50                                                  | Minimum round-trips (advocate → adversary) before convergence is allowed.                                                              |
| `max`                | `10`     | 1–50                                                  | Hard cap on round-trips. Forces synthesis on the advocate's `max`-th turn.                                                             |
| `convergence`        | `auto`   | `auto` \| `manual` \| `strict`                        | How the loop decides to stop.                                                                                                          |
| `synthesis`          | `merged` | `merged` \| `annotated` \| `diff`                     | Final output format.                                                                                                                   |
| `advocate_thinking`  | `off`    | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` | Reasoning level for the advocate role. Silently clamped to `off` on non-reasoning models. Aliases: `at`, `advocate-thinking`. |
| `adversary_thinking` | `off`    | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` | Reasoning level for the adversary role. Same clamping. Aliases: `adt`, `adversary-thinking`.                                  |

#### Convergence modes

- **`auto`** — the adversary is instructed to start its response with
  the literal token `[CONVERGED]` once it has no remaining substantive
  objections. The orchestrator only honors this signal after `min`
  round-trips have elapsed.
- **`manual`** — after every round-trip beyond `min`, pi prompts you
  with a confirm dialog: "Continue debate?"
- **`strict`** — ignore all convergence signals and run the full
  `max` round-trips. Useful for benchmarking.

#### Synthesis styles

- **`merged`** — the advocate's final turn is the synthesis. Clean,
  ready to use. This is the default and the most useful mode.
- **`annotated`** — the final answer followed by a list of every
  adversary critique, so you can see what got addressed.
- **`diff`** — the initial answer (T1) and the final answer side by
  side. Useful for seeing how much the answer changed under pressure.

### Examples

```bash
# Fast advocate, careful adversary, minimum interaction
/adversarial on anthropic/claude-haiku-4-5 anthropic/claude-opus-4-5 min=1 max=2

# Strict benchmark: exactly 5 round-trips, no early exit
/adversarial on anthropic/claude-sonnet-4-5 openai/gpt-5.3 min=5 max=5 convergence=strict

# Cross-provider debate with diff output
/adversarial on anthropic/claude-opus-4-5 google/gemini-2.5-pro synthesis=diff

# Cheap advocate, deep-thinking adversary — the best of both worlds
/adversarial on anthropic/claude-haiku-4-5 anthropic/claude-opus-4-5 \
    min=2 max=4 advocate_thinking=off adversary_thinking=high
```

#### Per-role reasoning levels

The `*_thinking` params map to pi-ai's `reasoning` option, which the
provider then translates into its native reasoning config:

- **Anthropic** — `thinking: { type: "enabled", budget_tokens: N }` with
  the budget growing with the level (`low` → 2048, `medium` → 8192,
  `high` → 16384, `xhigh` → 32768 on Opus 4.6).
- **OpenAI** — `reasoning_effort: "low" | "medium" | "high"`.
- **Google** — thinking budget for Gemini 2.5 reasoning models.

If you pick a non-reasoning model, the field is silently clamped to
`off` and the persisted config reflects that, so `/adversarial status`
is always honest about what's actually being sent. The interactive
setup flow only prompts for thinking levels on models where
`model.reasoning === true`.

## Context Isolation

The whole point of the extension is that the two roles can't see each
other's context. This is enforced structurally by the `Debater` class,
which holds a truly private `Message[]` history and a per-role
`systemPrompt`. Nothing outside the class can reach either of them.

The only way to advance a `Debater` is:

```ts
await debater.turn(userText, signal, onDelta)
```

which appends a single text user message, calls `stream()` with
**only** that debater's own system prompt and history, and returns
the extracted plain text of the response. Callers get plain strings
back — never `AssistantMessage` objects — so they cannot forward
thinking blocks, tool calls, or message metadata into the other
role's context even by accident.

### Empirical verification

The extension ships with a dormant debug hook. Set
`ADVERSARIAL_DEBUG_PAYLOADS` to a file path and every provider
payload from every turn gets captured with a `role` tag:

```bash
ADVERSARIAL_DEBUG_PAYLOADS=/tmp/payloads.jsonl pi
# ... run a debate ...
```

Then audit the captured payloads. The following invariants should
hold across every debate:

| Invariant | Check |
|---|---|
| **System prompt isolation** | Advocate payloads contain the advocate system prompt, never the adversary's. Vice versa. |
| **Assistant message isolation** | Every `role: "assistant"` message in an advocate payload matches byte-for-byte an advocate-produced text. None match any adversary-produced text. Vice versa. |
| **Turn history consistency** | The advocate's T_n payload contains exactly `n-1` prior assistant messages. Same for the adversary. |
| **Cross-role forwarding only as user messages** | The advocate's answers appear in the adversary's payloads only as `role: "user"` messages (the expected forwarding path), never as `role: "assistant"`. Vice versa. |

These checks can be automated — see `extensions/adversarial.ts` for
the exact payload format and the Debater class doc comment.

## Architecture

```text
User
  │
  ▼
Orchestrator (this extension, pure code — never an LLM)
  │
  │ 1. Intercepts the user's prompt via the `input` event
  │ 2. Aborts any in-flight debate if one is already running
  │ 3. Starts a new debate with a fresh AbortController
  │
  ▼
Debate loop:
  │
  ├─► Advocate (isolated Debater instance, its own model, prompt, history)
  │     ↓ stream() to provider, widget + status stream live
  │     ↓ full AssistantMessage pushed to its own history
  │     ↓ extracted plain text returned
  │
  ├─► Orchestrator commits advocate text to chat scrollback
  │
  ├─► Adversary (isolated Debater instance, its own model, prompt, history)
  │     ↓ receives only the original user prompt + advocate's plain text
  │     ↓ stream() to provider, widget + status stream live
  │     ↓ returns extracted plain text
  │
  ├─► Orchestrator commits adversary text to chat scrollback
  │
  ├─► Convergence check (auto | manual | strict)
  │
  └─► ...loop until final turn or convergence...

Synthesis → committed to chat scrollback
State persisted via pi.appendEntry on every enable/disable
Transcripts persisted automatically via pi.sendMessage
```

### Streaming UX

Each turn has three parallel streaming surfaces:

1. **Footer status** — `⚔ T2/4: advocate (claude-haiku-4-5) delivering
   final — 1.2k chars`, updated on every throttled delta.
2. **Widget above the editor** — the last 12 lines of the streaming
   text with a header line showing role, turn, and model tag. Clears
   when the turn commits.
3. **Chat scrollback** — the final committed text, once per turn,
   rendered through pi's `Markdown` component.

Updates are throttled to ~60ms to avoid flooding the terminal.

### Persistence

Mode state is stored via `pi.appendEntry("adversarial-state", ...)`
on every enable and disable, and restored on every `session_start`
event by walking the session branch in reverse for the most recent
state entry. Debate transcripts are stored as regular custom
messages and replay automatically on session load via the registered
message renderer.

**One caveat:** pi flushes the session lazily on the first assistant
message in a session. In a brand-new session where you only use
adversarial mode, nothing is written to disk until you also do one
normal (non-adversarial) chat turn. Resumed sessions persist
everything immediately. This is a pi core behavior, not an
extension-level issue. The extension documents it in
`/adversarial help`.

## Development

```bash
git clone https://github.com/nayeemzen/pi-adversary.git
cd pi-adversary

# Run pi with the extension loaded from source
pi -e ./extensions/adversarial.ts

# Run in RPC mode for automated testing
echo '{"type":"get_commands"}' | pi --mode rpc --no-session
```

### Testing

Because pi loads extensions through
[jiti](https://github.com/unjs/jiti), you can edit
`extensions/adversarial.ts` and re-run pi without a build step.

For automated end-to-end tests, use RPC mode:

```bash
(
  echo '{"id":"1","type":"prompt","message":"/adversarial on anthropic/claude-haiku-4-5 anthropic/claude-haiku-4-5 min=1 max=2"}'
  sleep 0.5
  echo '{"id":"2","type":"prompt","message":"What is a mutex?"}'
  sleep 30
) | pi --mode rpc --no-tools > /tmp/debate.jsonl 2>&1
```

### Context isolation regression test

```bash
rm -f /tmp/payloads.jsonl
ADVERSARIAL_DEBUG_PAYLOADS=/tmp/payloads.jsonl pi --mode rpc --no-tools < test-debate.jsonl
# Audit /tmp/payloads.jsonl for the invariants in Context Isolation above.
```

## Known limitations

- **Mid-debate user interjections don't inject into the next turn.**
  Currently they cancel the in-flight debate. The spec allows richer
  behavior (forward the interjection to both sessions before the next
  turn); implementing that cleanly requires more care around the
  streaming state machine.
- **Manual convergence mode blocks on a dialog** between every
  turn. Fine for small loops, annoying for `max=10` debates. Use
  `auto` unless you genuinely want to gatekeep every turn.
- **Persistence lazy-flush caveat** — see above. A brand-new session
  that never leaves adversarial mode will not write to disk until
  you exit the mode or do a normal chat turn.
- **No custom thinking budgets.** You can pick a reasoning level per
  role, but the actual token budget per level is whatever the
  provider's default is. Per-level budget tuning via
  `SimpleStreamOptions.thinkingBudgets` is plumbed in pi-ai but not
  exposed by this extension yet.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) `>= 0.65`
- Any provider pi supports, configured with a valid API key or OAuth
  credential. Anthropic, OpenAI, Google, Groq, xAI, OpenRouter,
  Cerebras, Bedrock, and more all work.

## License

MIT — see [LICENSE](LICENSE).

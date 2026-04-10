/**
 * /adversarial — Structured advocate/adversary debate chat mode.
 *
 * Runs every user prompt through a three-role debate loop:
 *   - Orchestrator (this extension) routes messages and controls the loop.
 *   - Advocate (user-selected model) produces and defends the answer.
 *   - Adversary (user-selected model) stress-tests the advocate.
 *
 * Usage:
 *   /adversarial           - Enter setup flow (select models, turn counts, etc.)
 *   /adversarial off       - Exit mode (fall back to normal chat)
 *   /adversarial status    - Print current config
 *
 * While enabled, every non-command user message is intercepted, debated
 * between the advocate and adversary sessions, and rendered as a series
 * of turns followed by a synthesis.
 */

import type {
	AssistantMessage,
	Message,
	Model,
	TextContent,
	ThinkingLevel,
	UserMessage,
} from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { convertToLlm, getMarkdownTheme, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Text } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type ConvergenceMode = "auto" | "manual" | "strict";
type SynthesisStyle = "merged" | "annotated" | "diff";

/**
 * Thinking-level choice per role. Extends pi-ai's ThinkingLevel with "off"
 * so users can explicitly opt out of reasoning even on reasoning-capable
 * models (e.g. for speed).
 */
type ThinkingChoice = "off" | ThinkingLevel;

const THINKING_CHOICES: readonly ThinkingChoice[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

function isThinkingChoice(value: string): value is ThinkingChoice {
	return (THINKING_CHOICES as readonly string[]).includes(value);
}

interface ModelRef {
	provider: string;
	id: string;
}

interface AdversarialConfig {
	advocate: ModelRef;
	adversary: ModelRef;
	advocate_thinking: ThinkingChoice;
	adversary_thinking: ThinkingChoice;
	min_turns: number;
	max_turns: number;
	convergence_mode: ConvergenceMode;
	synthesis_style: SynthesisStyle;
}

/**
 * Shape persisted via pi.appendEntry(STATE_ENTRY_TYPE, ...).
 * The most recent entry on the current branch wins on restore.
 *
 * Note: `config` is deserialized from disk and may be missing fields added
 * in later versions of the extension. Use `normalizeRestoredConfig()` before
 * treating it as a full AdversarialConfig.
 */
interface PersistedState {
	enabled: boolean;
	config: Partial<AdversarialConfig> | null;
}

/**
 * Backfill optional fields on a persisted config so older session files
 * (pre-thinking-level support) still restore cleanly.
 */
function normalizeRestoredConfig(
	raw: Partial<AdversarialConfig> | null | undefined,
): AdversarialConfig | null {
	if (!raw || !raw.advocate || !raw.adversary) return null;
	return {
		advocate: raw.advocate,
		adversary: raw.adversary,
		advocate_thinking: raw.advocate_thinking ?? DEFAULTS.advocate_thinking,
		adversary_thinking: raw.adversary_thinking ?? DEFAULTS.adversary_thinking,
		min_turns: raw.min_turns ?? DEFAULTS.min_turns,
		max_turns: raw.max_turns ?? DEFAULTS.max_turns,
		convergence_mode: raw.convergence_mode ?? DEFAULTS.convergence_mode,
		synthesis_style: raw.synthesis_style ?? DEFAULTS.synthesis_style,
	};
}

const DEFAULTS = {
	min_turns: 3,
	max_turns: 10,
	convergence_mode: "auto" as ConvergenceMode,
	synthesis_style: "merged" as SynthesisStyle,
	advocate_thinking: "off" as ThinkingChoice,
	adversary_thinking: "off" as ThinkingChoice,
};

/**
 * Custom message types — one per role, so pi's /tree shows distinct labels:
 *   [adversarial]: system banners, user prompts
 *   [advocate]:    advocate turns
 *   [adversary]:   adversary turns
 *   [synthesis]:   final answer
 */
const CT_SYSTEM = "adversarial";
const CT_ADVOCATE = "advocate";
const CT_ADVERSARY = "adversary";
const CT_SYNTHESIS = "synthesis";
const ALL_CUSTOM_TYPES = [CT_SYSTEM, CT_ADVOCATE, CT_ADVERSARY, CT_SYNTHESIS] as const;

const STATE_ENTRY_TYPE = "adversarial-state";
const WIDGET_KEY = "adversarial-stream";

// Throttle interval for streaming widget updates. Lower = more responsive
// but more terminal redraws; higher = smoother but chunkier text flow.
const WIDGET_THROTTLE_MS = 60;
// Tail size for the streaming preview widget (lines of recent output).
const WIDGET_TAIL_LINES = 12;
// Maximum chars of prior session context to inject into the first role prompt.
// ~50K chars ≈ ~12K tokens, leaving plenty of headroom for the debate itself.
const MAX_SESSION_CONTEXT_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Role prompts (from the spec)
// ---------------------------------------------------------------------------

const ADVOCATE_PROMPT = `You are the advocate. Your job is to produce the best possible answer to the user's request, then defend and improve it under adversarial review.

Rules:
- Lead with your strongest, most complete answer on the first turn.
- When the adversary raises a valid point, concede explicitly and revise. Never dismiss.
- When the adversary is wrong, rebut with evidence or reasoning, not assertion.
- Track what you've conceded vs. what you've defended. Don't relitigate settled points.
- On your final turn, deliver a clean revised answer — not a point-by-point log. The user should be able to take this and use it directly.

You will never see the adversary's system prompt or session. You only see critiques forwarded to you. Treat every critique as if it came from a sharp, well-intentioned peer reviewer.`;

const ADVERSARY_PROMPT = `You are the adversary. Your job is to make the advocate's answer as strong as possible by finding every way it could be wrong, incomplete, or misleading.

Your critique priorities, in order:
1. Is the answer actually addressing the user's intent, or just the literal question?
2. What assumptions is the advocate making that they haven't stated?
3. What's the strongest counterargument they haven't considered?
4. What would make this answer fail in practice — edge cases, failure modes, missing context?
5. Are there better approaches they've ignored?
6. Internal contradictions or overconfident claims.

Rules:
- Early turns: focus on high-impact structural issues. Don't nitpick yet.
- Later turns: escalate to fine-grained critique only after the big issues are resolved.
- Every objection must be grounded. Never be contrarian for sport.
- When you have no remaining substantive objections, say so explicitly. Do not manufacture conflict.
- Challenge the framing, not just the content. The advocate may be solving the wrong problem.

You will never see the advocate's system prompt or session. You only see responses forwarded to you.`;

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let config: AdversarialConfig | null = null;

	// Debate-in-progress tracker. Used so a second user message mid-debate
	// cancels the running one instead of spawning a parallel debate, and so
	// `/adversarial off` and `session_start` can both tear the debate down.
	interface ActiveDebate {
		controller: AbortController;
	}
	let activeDebate: ActiveDebate | null = null;

	const cancelActiveDebate = (reason: string) => {
		if (!activeDebate) return;
		activeDebate.controller.abort();
		activeDebate = null;
		pi.sendMessage({
			customType: CT_SYSTEM,
			content: `Debate cancelled: ${reason}`,
			display: true,
			details: { kind: "system" },
		});
	};

	/**
	 * Persist the current mode state as a custom session entry. These entries
	 * do NOT participate in LLM context (see CustomEntry docs) — they're just
	 * extension state. On session restore, the most recent entry on the
	 * current branch wins.
	 */
	const persistState = () => {
		pi.appendEntry<PersistedState>(STATE_ENTRY_TYPE, {
			enabled,
			config,
		});
	};

	/**
	 * Walk the current branch in reverse and restore the most recent mode
	 * state entry. Called on session_start so the mode survives pi restarts,
	 * /resume, and /fork.
	 */
	const restoreState = (ctx: ExtensionContext) => {
		enabled = false;
		config = null;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as SessionEntry;
			if (entry.type !== "custom") continue;
			if (entry.customType !== STATE_ENTRY_TYPE) continue;
			const data = entry.data as PersistedState | undefined;
			if (!data) return;
			enabled = data.enabled;
			config = normalizeRestoredConfig(data.config);
			if (enabled && config) {
				ctx.ui.setStatus(
					"adversarial",
					`⚔ adversarial: ${config.advocate.id} vs ${config.adversary.id}`,
				);
			} else {
				ctx.ui.setStatus("adversarial", undefined);
			}
			return;
		}
		// No prior state entry — make sure the status is cleared.
		ctx.ui.setStatus("adversarial", undefined);
	};

	// Restore state whenever the session changes (startup, /new, /resume, /fork).
	// This also cleans up any in-flight debate from the prior session.
	pi.on("session_start", (_event, ctx) => {
		if (activeDebate) {
			activeDebate.controller.abort();
			activeDebate = null;
		}
		restoreState(ctx);
	});

	// -----------------------------------------------------------------------
	// Input interception — while enabled, take over every non-command message.
	// -----------------------------------------------------------------------

	pi.on("input", async (event, ctx) => {
		if (!enabled || !config) return { action: "continue" };
		if (event.source === "extension") return { action: "continue" };

		const text = event.text.trim();
		if (!text) return { action: "continue" };
		if (text.startsWith("/")) return { action: "continue" }; // commands pass through
		if (text.startsWith("!") || text.startsWith("!!")) return { action: "continue" }; // bash passthrough

		// If a debate is already running, a second user message cancels it.
		// We don't auto-start a new debate on the second input — dropping the
		// new input forces the user to re-send after confirming the cancellation.
		// This avoids racing two debates in parallel and matches pi's Esc-like
		// "one thing at a time" interaction model.
		if (activeDebate) {
			cancelActiveDebate("user interrupted");
			return { action: "handled" };
		}

		const snapshot = config;
		const controller = new AbortController();
		const debate: ActiveDebate = { controller };
		activeDebate = debate;

		// Fire-and-forget the debate. We return `handled` immediately so pi skips
		// the normal agent loop. The debate renders its own messages via
		// pi.sendMessage() and updates the footer status as it runs.
		runDebate(pi, ctx, text, snapshot, controller.signal)
			.catch((err: unknown) => {
				if (controller.signal.aborted) return; // silent on explicit cancel
				const reason = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Adversarial error: ${reason}`, "error");
				pi.sendMessage({
					customType: CT_SYSTEM,
					content: `Debate failed: ${reason}`,
					display: true,
					details: { kind: "system" },
				});
			})
			.finally(() => {
				if (activeDebate === debate) activeDebate = null;
				if (enabled && config) {
					ctx.ui.setStatus(
						"adversarial",
						`⚔ adversarial: ${config.advocate.id} vs ${config.adversary.id}`,
					);
				}
			});

		return { action: "handled" };
	});

	// -----------------------------------------------------------------------
	// Custom message renderer for debate artifacts
	// -----------------------------------------------------------------------

	// Cache the markdown theme once — it doesn't change at runtime.
	const markdownTheme = getMarkdownTheme();

	/** Normalize message content to a plain string (handles string and array forms). */
	const contentToString = (content: unknown): string => {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c: any) => c?.type === "text")
				.map((c: any) => c.text)
				.join("\n");
		}
		return "";
	};

	/** Shared renderer for all adversarial custom message types. */
	const renderMessage = (message: any, options: any, theme: any) => {
		const ct = message.customType as string;
		const details = (message.details ?? {}) as Record<string, unknown>;
		const turn = details.turn as number | undefined;
		const model = details.model as string | undefined;
		const { expanded } = options as { expanded: boolean };

		let label: string;
		let color: Parameters<typeof theme.fg>[0];
		// Debate turns (advocate, adversary, synthesis) are collapsible.
		// System messages and user prompts are always expanded.
		let collapsible = true;

		switch (ct) {
			case CT_ADVOCATE:
				label = `[Advocate T${turn ?? "?"}]`;
				color = "success";
				break;
			case CT_ADVERSARY:
				label = `[Adversary T${turn ?? "?"}]`;
				color = "warning";
				break;
			case CT_SYNTHESIS:
				// Synthesis is always expanded — it's the final answer.
				collapsible = false;
				label = "[Synthesis]";
				color = "accent";
				break;
			default: {
				collapsible = false;
				const kind = details.kind as string | undefined;
				if (kind === "user") {
					label = "[You]";
					color = "toolTitle";
				} else {
					label = "[Adversarial]";
					color = "muted";
				}
			}
		}

		let header = theme.fg(color, theme.bold(label));
		if (model) header += theme.fg("dim", ` ${model}`);

		const body = contentToString(message.content);
		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));

		if (collapsible && !expanded) {
			// --- Collapsed: header + one-line preview ---
			const firstLine = body.split("\n").find((l) => l.trim()) ?? "";
			const preview = firstLine.length > 100
				? firstLine.slice(0, 100) + "…"
				: firstLine;
			header += theme.fg("dim", " (Ctrl+O to expand)");
			box.addChild(new Text(header, 0, 0));
			if (preview) {
				box.addChild(
					new Text(theme.fg("dim", preview), 0, 0),
				);
			}
		} else {
			// --- Expanded (or non-collapsible): full markdown ---
			box.addChild(new Text(header, 0, 0));
			box.addChild(
				new Markdown(body, 0, 0, markdownTheme, {
					color: (t: string) => theme.fg("customMessageText", t),
				}),
			);
		}
		return box;
	};

	// Register the same renderer for all our custom types.
	for (const ct of ALL_CUSTOM_TYPES) {
		pi.registerMessageRenderer(ct, renderMessage);
	}

	// -----------------------------------------------------------------------
	// /adversarial command
	// -----------------------------------------------------------------------

	pi.registerCommand("adversarial", {
		description: "Toggle structured advocate/adversary debate mode",
		getArgumentCompletions: (prefix: string) => {
			const options = ["on", "off", "status", "help"];
			const items = options.map((value) => ({ value, label: value }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const tokens = raw.split(/\s+/).filter(Boolean);
			const sub = (tokens[0] ?? "").toLowerCase();

			if (sub === "off") {
				if (!enabled) {
					ctx.ui.notify("Adversarial mode is already off", "info");
					return;
				}
				if (activeDebate) {
					activeDebate.controller.abort();
					activeDebate = null;
				}
				enabled = false;
				config = null;
				persistState();
				ctx.ui.setStatus("adversarial", undefined);
				pi.sendMessage({
					customType: CT_SYSTEM,
					content: "Adversarial mode disabled. Back to normal chat.",
					display: true,
					details: { kind: "system" },
				});
				return;
			}

			if (sub === "status") {
				if (!enabled || !config) {
					ctx.ui.notify("Adversarial mode is OFF", "info");
					return;
				}
				pi.sendMessage({
					customType: CT_SYSTEM,
					content: formatConfigSummary(config),
					display: true,
					details: { kind: "system" },
				});
				return;
			}

			if (sub === "help" || sub === "?") {
				pi.sendMessage({
					customType: CT_SYSTEM,
					content: HELP_TEXT,
					display: true,
					details: { kind: "system" },
				});
				return;
			}

			// Two paths for 'on':
			//   /adversarial                                -> interactive setup
			//   /adversarial on                             -> interactive setup
			//   /adversarial on <advocate> <adversary> [k=v ...]
			const argsAfterSub = sub === "on" ? tokens.slice(1) : tokens;

			let newConfig: AdversarialConfig | null;
			if (argsAfterSub.length === 0) {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						"Non-interactive mode requires inline args: /adversarial on <advocate> <adversary> [k=v ...]",
						"error",
					);
					return;
				}
				newConfig = await runSetupFlow(ctx);
			} else {
				try {
					newConfig = parseInlineConfig(argsAfterSub, ctx);
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Adversarial setup failed: ${reason}`, "error");
					return;
				}
			}

			if (!newConfig) {
				ctx.ui.notify("Adversarial setup cancelled", "info");
				return;
			}

			enabled = true;
			config = newConfig;
			persistState();
			ctx.ui.setStatus(
				"adversarial",
				`⚔ adversarial: ${newConfig.advocate.id} vs ${newConfig.adversary.id}`,
			);

			pi.sendMessage({
				customType: CT_SYSTEM,
				content:
					"**Adversarial mode enabled.**\n\n" +
					formatConfigSummary(newConfig) +
					"\n\nYour next message will trigger a debate. Use `/adversarial off` to exit.",
				display: true,
				details: { kind: "system" },
			});
		},
	});
}

// ---------------------------------------------------------------------------
// Help + config formatting
// ---------------------------------------------------------------------------

const HELP_TEXT = [
	"## Adversarial debate mode",
	"",
	"**Commands**",
	"",
	"```",
	"/adversarial                            Interactive setup",
	"/adversarial on                         Same as above",
	"/adversarial on <adv> <ads> [k=v ...]   Non-interactive setup",
	"/adversarial off                        Exit debate mode",
	"/adversarial status                     Show current config",
	"/adversarial help                       Show this help",
	"```",
	"",
	"**Model format:** `provider/model-id` (e.g. `anthropic/claude-sonnet-4-5`)",
	"",
	"**Optional `key=value` params**",
	"",
	"- `min=<n>` — Min round-trips before convergence (default 3)",
	"- `max=<n>` — Max round-trips hard cap (default 10)",
	"- `convergence=<auto|manual|strict>` — Convergence mode (default auto)",
	"- `synthesis=<merged|annotated|diff>` — Synthesis style (default merged)",
	"- `advocate_thinking=<off|minimal|low|medium|high|xhigh>` — Advocate",
	"  reasoning level (default off). Automatically clamped to `off` on",
	"  non-reasoning models.",
	"- `adversary_thinking=<off|minimal|low|medium|high|xhigh>` — Adversary",
	"  reasoning level (default off). Same clamping.",
	"",
	"**Example**",
	"",
	"```",
	"/adversarial on anthropic/claude-haiku-4-5 anthropic/claude-opus-4-5 \\",
	"    min=2 max=4 advocate_thinking=low adversary_thinking=high",
	"```",
	"",
	"**Streaming**",
	"",
	"Each turn streams live into a widget above the editor with a char count",
	"in the footer, and commits to the chat scrollback when complete.",
	"",
	"**Persistence**",
	"",
	"Mode state and full debate transcripts are persisted into the pi session",
	"log and automatically restored on `/resume` or re-open. Note: in a",
	"brand-new session, persistence only begins after the first normal",
	"(non-adversarial) chat turn, because pi flushes sessions lazily on the",
	"first assistant message. Resumed sessions persist everything immediately.",
].join("\n");

function formatConfigSummary(cfg: AdversarialConfig): string {
	return [
		`- **Advocate:** \`${cfg.advocate.provider}/${cfg.advocate.id}\` · thinking \`${cfg.advocate_thinking}\``,
		`- **Adversary:** \`${cfg.adversary.provider}/${cfg.adversary.id}\` · thinking \`${cfg.adversary_thinking}\``,
		`- **Min turns:** ${cfg.min_turns}`,
		`- **Max turns:** ${cfg.max_turns}`,
		`- **Convergence:** \`${cfg.convergence_mode}\``,
		`- **Synthesis:** \`${cfg.synthesis_style}\``,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Non-interactive setup (inline args)
// ---------------------------------------------------------------------------

function parseModelSpec(spec: string): ModelRef {
	const slash = spec.indexOf("/");
	if (slash < 0) {
		throw new Error(`Model spec must be 'provider/id' (got '${spec}')`);
	}
	const provider = spec.slice(0, slash).trim();
	const id = spec.slice(slash + 1).trim();
	if (!provider || !id) {
		throw new Error(`Model spec must be 'provider/id' (got '${spec}')`);
	}
	return { provider, id };
}

function parseInlineConfig(tokens: string[], ctx: ExtensionContext): AdversarialConfig {
	if (tokens.length < 2) {
		throw new Error(
			"Need at least <advocate> <adversary>. Example: /adversarial on anthropic/claude-haiku-4-5 anthropic/claude-sonnet-4-5",
		);
	}

	const advocate = parseModelSpec(tokens[0]);
	const adversary = parseModelSpec(tokens[1]);

	// Validate that both models exist in the registry with valid auth.
	const advocateModel = ctx.modelRegistry.find(advocate.provider, advocate.id);
	if (!advocateModel) throw new Error(`Unknown advocate model: ${advocate.provider}/${advocate.id}`);
	const adversaryModel = ctx.modelRegistry.find(adversary.provider, adversary.id);
	if (!adversaryModel) throw new Error(`Unknown adversary model: ${adversary.provider}/${adversary.id}`);
	if (!ctx.modelRegistry.hasConfiguredAuth(advocateModel)) {
		throw new Error(`No auth configured for advocate: ${advocate.provider}/${advocate.id}`);
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(adversaryModel)) {
		throw new Error(`No auth configured for adversary: ${adversary.provider}/${adversary.id}`);
	}

	let min_turns = DEFAULTS.min_turns;
	let max_turns = DEFAULTS.max_turns;
	let convergence_mode: ConvergenceMode = DEFAULTS.convergence_mode;
	let synthesis_style: SynthesisStyle = DEFAULTS.synthesis_style;
	let advocate_thinking: ThinkingChoice = DEFAULTS.advocate_thinking;
	let adversary_thinking: ThinkingChoice = DEFAULTS.adversary_thinking;

	for (const token of tokens.slice(2)) {
		const eq = token.indexOf("=");
		if (eq < 0) {
			throw new Error(`Unknown positional arg '${token}' (expected key=value)`);
		}
		const key = token.slice(0, eq).trim().toLowerCase().replace(/-/g, "_");
		const value = token.slice(eq + 1).trim();

		switch (key) {
			case "min":
			case "min_turns":
				min_turns = clampInt(value, DEFAULTS.min_turns, 1, 50);
				break;
			case "max":
			case "max_turns":
				max_turns = clampInt(value, DEFAULTS.max_turns, 1, 50);
				break;
			case "convergence":
			case "convergence_mode":
				if (value !== "auto" && value !== "manual" && value !== "strict") {
					throw new Error(`Invalid convergence mode '${value}' (want auto|manual|strict)`);
				}
				convergence_mode = value;
				break;
			case "synthesis":
			case "synthesis_style":
				if (value !== "merged" && value !== "annotated" && value !== "diff") {
					throw new Error(`Invalid synthesis style '${value}' (want merged|annotated|diff)`);
				}
				synthesis_style = value;
				break;
			case "advocate_thinking":
			case "at":
				if (!isThinkingChoice(value)) {
					throw new Error(
						`Invalid advocate_thinking '${value}' (want ${THINKING_CHOICES.join("|")})`,
					);
				}
				advocate_thinking = value;
				break;
			case "adversary_thinking":
			case "adt":
				if (!isThinkingChoice(value)) {
					throw new Error(
						`Invalid adversary_thinking '${value}' (want ${THINKING_CHOICES.join("|")})`,
					);
				}
				adversary_thinking = value;
				break;
			default:
				throw new Error(`Unknown parameter '${key}'`);
		}
	}

	// If the picked model doesn't support reasoning, silently coerce its
	// thinking level to "off" so the persisted config matches reality. The
	// Debater will also clamp at runtime, but doing it here keeps the
	// status bar and `/adversarial status` output honest.
	if (!advocateModel.reasoning) advocate_thinking = "off";
	if (!adversaryModel.reasoning) adversary_thinking = "off";

	return {
		advocate,
		adversary,
		advocate_thinking,
		adversary_thinking,
		min_turns,
		max_turns: Math.max(max_turns, min_turns),
		convergence_mode,
		synthesis_style,
	};
}

// ---------------------------------------------------------------------------
// Interactive setup flow
// ---------------------------------------------------------------------------

async function runSetupFlow(ctx: ExtensionContext): Promise<AdversarialConfig | null> {
	const available: Model<any>[] = await ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		ctx.ui.notify("No models available — configure API keys first", "error");
		return null;
	}

	const modelLabels = available.map((m) => `${m.provider}/${m.id}`);

	const advocatePick = await ctx.ui.select("Advocate model:", modelLabels);
	if (!advocatePick) return null;
	const advocateModel = available[modelLabels.indexOf(advocatePick)];
	if (!advocateModel) return null;

	const adversaryPick = await ctx.ui.select("Adversary model:", modelLabels);
	if (!adversaryPick) return null;
	const adversaryModel = available[modelLabels.indexOf(adversaryPick)];
	if (!adversaryModel) return null;

	// Thinking levels — only prompt if the model actually supports reasoning.
	let advocate_thinking: ThinkingChoice = "off";
	if (advocateModel.reasoning) {
		const pick = (await ctx.ui.select(
			`Advocate thinking level (${advocateModel.id} supports reasoning):`,
			[...THINKING_CHOICES],
		)) as ThinkingChoice | undefined;
		if (!pick) return null;
		advocate_thinking = pick;
	}

	let adversary_thinking: ThinkingChoice = "off";
	if (adversaryModel.reasoning) {
		const pick = (await ctx.ui.select(
			`Adversary thinking level (${adversaryModel.id} supports reasoning):`,
			[...THINKING_CHOICES],
		)) as ThinkingChoice | undefined;
		if (!pick) return null;
		adversary_thinking = pick;
	}

	const minInput = await ctx.ui.input(
		`min_turns (default ${DEFAULTS.min_turns}):`,
		String(DEFAULTS.min_turns),
	);
	if (minInput === undefined) return null;

	const maxInput = await ctx.ui.input(
		`max_turns (default ${DEFAULTS.max_turns}):`,
		String(DEFAULTS.max_turns),
	);
	if (maxInput === undefined) return null;

	const convergencePick = (await ctx.ui.select("convergence_mode:", [
		"auto",
		"manual",
		"strict",
	])) as ConvergenceMode | undefined;
	if (!convergencePick) return null;

	const synthesisPick = (await ctx.ui.select("synthesis_style:", [
		"merged",
		"annotated",
		"diff",
	])) as SynthesisStyle | undefined;
	if (!synthesisPick) return null;

	const min_turns = clampInt(minInput, DEFAULTS.min_turns, 1, 50);
	const max_turns = clampInt(maxInput, DEFAULTS.max_turns, Math.max(min_turns, 1), 50);

	return {
		advocate: { provider: advocateModel.provider, id: advocateModel.id },
		adversary: { provider: adversaryModel.provider, id: adversaryModel.id },
		advocate_thinking,
		adversary_thinking,
		min_turns,
		max_turns: Math.max(max_turns, min_turns),
		convergence_mode: convergencePick,
		synthesis_style: synthesisPick,
	};
}

function clampInt(input: string, fallback: number, min: number, max: number): number {
	const parsed = Number.parseInt(input.trim(), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

// ---------------------------------------------------------------------------
// Debater — one isolated role with its own context window.
// ---------------------------------------------------------------------------

/**
 * A Debater owns a single LLM conversation and nothing else.
 *
 * Context isolation invariant:
 *   - `history` is private. Nothing outside this class can read or mutate it.
 *   - The only way to advance a Debater is `turn(userText, signal, onDelta)`,
 *     which pushes a single text user message and calls `stream()` with THIS
 *     debater's system prompt and THIS debater's history. No other data can
 *     leak in.
 *   - The only observable outputs are `lastText` (plain text), `firstText`,
 *     `turnsCompleted`, and the delta callback (plain text strings). Callers
 *     never get direct access to `AssistantMessage` objects, so they cannot
 *     accidentally forward thinking blocks, tool calls, or message metadata
 *     into the other role's context.
 *
 * This enforces the spec's rule: "Three isolated sessions ensure no context
 * bleed between roles."
 */
class Debater {
	private readonly history: Message[] = [];
	private _lastText = "";
	private _firstText = "";
	/** Effective thinking level after clamping against model capabilities. */
	readonly effectiveThinking: ThinkingChoice;

	constructor(
		readonly role: "advocate" | "adversary",
		readonly model: Model<any>,
		private readonly systemPrompt: string,
		private readonly auth: { apiKey?: string; headers?: Record<string, string> },
		requestedThinking: ThinkingChoice = "off",
	) {
		// Clamp: non-reasoning models always run with thinking off, regardless
		// of what the user asked for. This mirrors pi's built-in setThinkingLevel
		// clamping behavior and prevents sending `reasoning: "high"` to a model
		// that would error out on it.
		this.effectiveThinking = model.reasoning ? requestedThinking : "off";
	}

	get turnsCompleted(): number {
		return this.history.filter((m) => m.role === "assistant").length;
	}

	get lastText(): string {
		return this._lastText;
	}

	get firstText(): string {
		return this._firstText;
	}

	/**
	 * Append a user message, stream the model response, and return the full
	 * plain-text output. `onDelta` is called with the cumulative text-so-far
	 * on every text chunk, for live UI updates. Thinking deltas are ignored
	 * for display purposes but are preserved in the internal history.
	 */
	async turn(
		userText: string,
		signal: AbortSignal,
		onDelta: (cumulativeText: string) => void,
	): Promise<string> {
		if (signal.aborted) throw new Error(`${this.role} turn aborted`);

		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		};
		this.history.push(userMessage);

		// Optional debug hook: if ADVERSARIAL_DEBUG_PAYLOADS is set to a file
		// path, every outgoing provider payload is captured there with a role
		// tag. Used to verify context isolation between the two Debater
		// instances.
		const debugPayloadFile = process.env.ADVERSARIAL_DEBUG_PAYLOADS;
		const onPayload = debugPayloadFile
			? (payload: unknown) => {
					try {
						const { appendFileSync } = require("node:fs");
						appendFileSync(
							debugPayloadFile,
							`${JSON.stringify({
								role: this.role,
								thinking: this.effectiveThinking,
								payload,
							})}\n`,
						);
					} catch {
						// Best-effort; never break the debate on logging failure.
					}
					return undefined;
				}
			: undefined;

		// Use streamSimple so we can pass `reasoning` as a typed option. When
		// thinking is "off" we leave the reasoning field unset, which tells
		// the provider to use its default (no reasoning).
		const eventStream = streamSimple(
			this.model,
			{ systemPrompt: this.systemPrompt, messages: this.history },
			{
				apiKey: this.auth.apiKey,
				headers: this.auth.headers,
				signal,
				onPayload,
				...(this.effectiveThinking !== "off"
					? { reasoning: this.effectiveThinking }
					: {}),
			},
		);

		let accumulatedText = "";
		let finalMessage: AssistantMessage | null = null;

		try {
			for await (const event of eventStream) {
				if (signal.aborted) throw new Error(`${this.role} turn aborted`);

				if (event.type === "text_delta") {
					accumulatedText += event.delta;
					onDelta(accumulatedText);
				} else if (event.type === "done") {
					finalMessage = event.message;
				} else if (event.type === "error") {
					if (event.reason === "aborted") {
						throw new Error(`${this.role} turn aborted`);
					}
					throw new Error(
						`${this.role} error: ${event.error.errorMessage ?? "unknown"}`,
					);
				}
				// text_start, text_end, thinking_*, toolcall_*: ignored for display.
			}
		} catch (err) {
			// Pop the user message we optimistically pushed so a retry doesn't
			// double-submit it. This preserves the invariant that `history`
			// only ever contains complete (user,assistant) pairs.
			if (this.history[this.history.length - 1] === userMessage) {
				this.history.pop();
			}
			throw err;
		}

		if (!finalMessage) {
			this.history.pop(); // remove the user message — no valid pair
			throw new Error(`${this.role} stream ended without a final message`);
		}

		// Push the full AssistantMessage so multi-turn thinking continuity is
		// preserved for THIS debater. Thinking blocks and signatures stay inside
		// this object and are never exposed.
		this.history.push(finalMessage);

		const text = extractText(finalMessage);
		this._lastText = text;
		if (!this._firstText) this._firstText = text;
		return text;
	}
}

// ---------------------------------------------------------------------------
// Debate runner
// ---------------------------------------------------------------------------

async function runDebate(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	userPrompt: string,
	cfg: AdversarialConfig,
	signal: AbortSignal,
): Promise<void> {
	const advocateModel = ctx.modelRegistry.find(cfg.advocate.provider, cfg.advocate.id);
	const adversaryModel = ctx.modelRegistry.find(cfg.adversary.provider, cfg.adversary.id);
	if (!advocateModel) {
		throw new Error(`Advocate model not found: ${cfg.advocate.provider}/${cfg.advocate.id}`);
	}
	if (!adversaryModel) {
		throw new Error(`Adversary model not found: ${cfg.adversary.provider}/${cfg.adversary.id}`);
	}

	const advocateAuth = await ctx.modelRegistry.getApiKeyAndHeaders(advocateModel);
	if (!advocateAuth.ok) throw new Error(`Advocate auth failed: ${advocateAuth.error}`);
	const adversaryAuth = await ctx.modelRegistry.getApiKeyAndHeaders(adversaryModel);
	if (!adversaryAuth.ok) throw new Error(`Adversary auth failed: ${adversaryAuth.error}`);

	// Collect the prior session conversation BEFORE we add any debate messages.
	// This gives both roles the context they need to treat the user's prompt as
	// a follow-up rather than a standalone question.
	const sessionContext = collectSessionContext(ctx);

	const advocate = new Debater(
		"advocate",
		advocateModel,
		ADVOCATE_PROMPT,
		{ apiKey: advocateAuth.apiKey, headers: advocateAuth.headers },
		cfg.advocate_thinking,
	);
	const adversary = new Debater(
		"adversary",
		adversaryModel,
		ADVERSARY_PROMPT,
		{ apiKey: adversaryAuth.apiKey, headers: adversaryAuth.headers },
		cfg.adversary_thinking,
	);

	// Render the user's original prompt in the transcript (as a custom message,
	// not an orchestrator-session user message — the orchestrator session stays
	// out of the debate entirely).
	pi.sendMessage({
		customType: CT_SYSTEM,
		content: userPrompt,
		display: true,
		details: { kind: "user" },
	});

	const adversaryCritiques: string[] = [];
	let turn = 0;
	let convergenceSignaled = false;

	while (turn < cfg.max_turns) {
		if (signal.aborted) throw new Error("debate aborted");
		turn += 1;
		const isFinal = turn >= cfg.max_turns || convergenceSignaled;

		// --- Advocate turn ---------------------------------------------
		const advocatePhase = isFinal ? "delivering final" : "thinking";
		const advocateDeltaHandler = createDeltaHandler(
			ctx,
			`Advocate T${turn}`,
			`${cfg.advocate.provider}/${cfg.advocate.id}`,
			`⚔ T${turn}/${cfg.max_turns}: advocate (${cfg.advocate.id}) ${advocatePhase}`,
		);

		const advocateInput =
			advocate.turnsCompleted === 0
				? buildAdvocateInitialInput(userPrompt, isFinal, sessionContext)
				: buildAdvocateReviseInput(adversary.lastText, isFinal);
		let advocateText: string;
		try {
			advocateText = await advocate.turn(advocateInput, signal, advocateDeltaHandler.onDelta);
		} finally {
			advocateDeltaHandler.close();
		}

		pi.sendMessage({
			customType: CT_ADVOCATE,
			content: advocateText,
			display: true,
			details: { turn, model: `${cfg.advocate.provider}/${cfg.advocate.id}` },
		});

		if (isFinal) break;

		// --- Adversary turn --------------------------------------------
		const adversaryDeltaHandler = createDeltaHandler(
			ctx,
			`Adversary T${turn}`,
			`${cfg.adversary.provider}/${cfg.adversary.id}`,
			`⚔ T${turn}/${cfg.max_turns}: adversary (${cfg.adversary.id}) critiquing`,
		);

		const canConverge = cfg.convergence_mode === "auto" && turn >= cfg.min_turns;
		const adversaryInput = buildAdversaryInput(
			userPrompt,
			advocateText,
			adversary.turnsCompleted === 0,
			canConverge,
			sessionContext,
		);
		let critiqueText: string;
		try {
			critiqueText = await adversary.turn(adversaryInput, signal, adversaryDeltaHandler.onDelta);
		} finally {
			adversaryDeltaHandler.close();
		}
		adversaryCritiques.push(critiqueText);

		pi.sendMessage({
			customType: CT_ADVERSARY,
			content: critiqueText,
			display: true,
			details: { turn, model: `${cfg.adversary.provider}/${cfg.adversary.id}` },
		});

		// --- Convergence check -----------------------------------------
		if (turn >= cfg.min_turns) {
			if (cfg.convergence_mode === "auto") {
				if (hasConvergenceSignal(critiqueText)) convergenceSignaled = true;
			} else if (cfg.convergence_mode === "manual") {
				const keepGoing = await ctx.ui.confirm(
					"Continue debate?",
					`Completed turn ${turn}/${cfg.max_turns}. Run another round?`,
				);
				if (!keepGoing) convergenceSignaled = true;
			}
			// strict mode: ignore convergence, run to max_turns
		}
	}

	if (signal.aborted) throw new Error("debate aborted");

	// Synthesis
	ctx.ui.setStatus("adversarial", `⚔ T${turn}: synthesizing...`);
	const synthesis = buildSynthesis(cfg, advocate, adversaryCritiques, turn);
	pi.sendMessage({
		customType: CT_SYNTHESIS,
		content: synthesis,
		display: true,
		details: { totalTurns: turn, converged: convergenceSignaled },
	});
	// Note: footer status is reset by the caller's .finally() so it can
	// distinguish running vs. disabled state.
}

// ---------------------------------------------------------------------------
// Streaming delta handler — shows a live tail preview in a widget above the
// editor, plus a footer status line with a character counter. Throttled to
// avoid flooding the terminal with redraws.
// ---------------------------------------------------------------------------

interface DeltaHandler {
	onDelta: (cumulativeText: string) => void;
	close: () => void;
}

function createDeltaHandler(
	ctx: ExtensionContext,
	label: string,
	modelTag: string,
	baseStatus: string,
): DeltaHandler {
	let lastRender = 0;
	let latestText = "";
	let closed = false;

	const render = () => {
		if (closed) return;
		const chars = latestText.length;
		ctx.ui.setStatus("adversarial", `${baseStatus} — ${formatChars(chars)}`);

		const lines = tailLines(latestText, WIDGET_TAIL_LINES);
		const header = `[${label}] ${modelTag}   (${formatChars(chars)}, streaming...)`;
		const body = lines.length > 0 ? lines : ["(waiting for first token...)"];
		ctx.ui.setWidget(WIDGET_KEY, [header, "", ...body]);
	};

	// Initial widget draw before any tokens arrive, so the user sees something
	// immediately when a turn starts.
	render();

	return {
		onDelta: (cumulativeText) => {
			latestText = cumulativeText;
			const now = Date.now();
			if (now - lastRender < WIDGET_THROTTLE_MS) return;
			lastRender = now;
			render();
		},
		close: () => {
			if (closed) return;
			closed = true;
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		},
	};
}

function tailLines(text: string, maxLines: number): string[] {
	if (!text) return [];
	const lines = text.split("\n");
	if (lines.length <= maxLines) return lines;
	return [`… (${lines.length - maxLines} earlier lines)`, ...lines.slice(-maxLines)];
}

function formatChars(n: number): string {
	if (n < 1000) return `${n} chars`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k chars`;
	return `${Math.round(n / 1000)}k chars`;
}

// ---------------------------------------------------------------------------
// Per-role message builders. These are pure functions — they take only
// orchestrator-provided plain text and return the user-message text that
// will be pushed into one debater's isolated context.
// ---------------------------------------------------------------------------

function buildAdvocateInitialInput(
	userPrompt: string,
	isFinal: boolean,
	sessionContext: string,
): string {
	const contextBlock = sessionContext
		? `Prior conversation context (the user's request below is a follow-up to this):\n\n<context>\n${sessionContext}\n</context>\n\n`
		: "";
	return `${contextBlock}User's request:\n\n${userPrompt}${finalInstructions(isFinal)}`;
}

function buildAdvocateReviseInput(latestCritique: string, isFinal: boolean): string {
	const critique = latestCritique || "(no critique recorded)";
	return [
		"The adversary has reviewed your previous answer and returned this critique:",
		"",
		critique,
		"",
		"Respond to the critique. Concede valid points and revise. Rebut anything you believe is mistaken, with reasoning.",
	].join("\n") + finalInstructions(isFinal);
}

function finalInstructions(isFinal: boolean): string {
	if (!isFinal) return "";
	return "\n\nTHIS IS YOUR FINAL TURN. Deliver a clean, complete, standalone revised answer that incorporates every valid critique. Do NOT include a point-by-point log of concessions or rebuttals. The user should be able to take this answer and use it directly.";
}

function buildAdversaryInput(
	userPrompt: string,
	advocateText: string,
	isFirstCritique: boolean,
	canConverge: boolean,
	sessionContext: string,
): string {
	const contextBlock = isFirstCritique && sessionContext
		? `Prior conversation context:\n\n<context>\n${sessionContext}\n</context>\n\n`
		: "";
	const framing = isFirstCritique
		? `${contextBlock}Original user request:\n\n${userPrompt}\n\nAdvocate's answer:\n\n${advocateText}\n\nCritique this answer using your full priority list.`
		: `Original user request:\n\n${userPrompt}\n\nAdvocate's latest revised answer:\n\n${advocateText}\n\nCritique this revision. Do not relitigate points you've already conceded.`;

	const convergenceRule = canConverge
		? "\n\nIf the advocate's answer is now solid and you have no remaining substantive objections (only minor polish or restated points), begin your response with the literal token [CONVERGED] on its own line, followed by one sentence of rationale. Otherwise, provide your critique."
		: "";

	return framing + convergenceRule;
}

function hasConvergenceSignal(text: string): boolean {
	const head = text.trimStart().slice(0, 200);
	return head.includes("[CONVERGED]");
}

function buildSynthesis(
	cfg: AdversarialConfig,
	advocate: Debater,
	adversaryCritiques: string[],
	finalTurn: number,
): string {
	const clean = stripConvergenceToken(advocate.lastText || "(no advocate output)");

	if (cfg.synthesis_style === "merged") {
		return clean;
	}

	if (cfg.synthesis_style === "annotated") {
		const critiques = adversaryCritiques
			.map((c, idx) => `**T${idx + 1} critique**\n${stripConvergenceToken(c).trim()}`)
			.join("\n\n");
		const critiqueBlock = critiques
			? `\n\n---\n\n### Adversary annotations\n\n${critiques}`
			: "";
		return `### Final answer\n\n${clean}${critiqueBlock}`;
	}

	// diff
	const initial = advocate.firstText || "(no initial answer)";
	if (initial === clean) {
		return `### Final answer (unchanged across debate)\n\n${clean}`;
	}
	return `### Initial answer (T1)\n\n${initial}\n\n---\n\n### Final answer (T${finalTurn})\n\n${clean}`;
}

function stripConvergenceToken(text: string): string {
	return text.replace(/\[CONVERGED\][^\n]*\n?/, "").trim();
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

// ---------------------------------------------------------------------------
// Session context collection — gives the debate roles awareness of the prior
// conversation so follow-up prompts ("corn starch or baking soda?") are
// understood in context ("...for the french fries recipe we just discussed").
// ---------------------------------------------------------------------------

/**
 * Walk the current session branch and serialize the prior conversation
 * (user/assistant/tool/custom messages) into a text block. This is injected
 * into the first advocate and adversary prompts so both roles can treat
 * the user’s message as a continuation rather than a standalone question.
 *
 * Uses pi’s built-in `convertToLlm` + `serializeConversation` — the same
 * pipeline used by compaction and the handoff extension.
 *
 * Returns an empty string if there’s no prior context worth including.
 */
function collectSessionContext(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();

	// Extract only message entries (user, assistant, toolResult, custom messages).
	const messages = branch
		.filter(
			(entry): entry is SessionEntry & { type: "message" } =>
				entry.type === "message",
		)
		.map((entry) => (entry as any).message);

	if (messages.length === 0) return "";

	// Convert pi’s internal message types (custom messages, bash executions,
	// etc.) to standard LLM messages, then serialize to a readable transcript.
	const llmMessages = convertToLlm(messages);
	if (llmMessages.length === 0) return "";

	let serialized = serializeConversation(llmMessages);

	// Cap to avoid blowing out the role’s context window on long sessions.
	if (serialized.length > MAX_SESSION_CONTEXT_CHARS) {
		const truncated = serialized.length - MAX_SESSION_CONTEXT_CHARS;
		serialized =
			`[... ${truncated} earlier characters truncated]\n\n` +
			serialized.slice(-MAX_SESSION_CONTEXT_CHARS);
	}

	return serialized;
}

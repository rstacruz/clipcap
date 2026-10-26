import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getMarkdownTheme } from "@oh-my-pi/pi-coding-agent";
import { type Component, Container, Markdown, type ThemeColor, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { RECAP_PROMPT, replayRecap, type AssumedStatus, type RecapStatus, type Replay } from "./recap.ts";
import {
	type CompactParts,
	compactParts,
	fitCompact,
	greetingText,
	nextViewMode,
	userName,
	type ViewMode,
} from "./view.ts";

/** Env seconds as milliseconds; 0 or unparsable disables */
function envDelayMs(name: string, fallbackSeconds: number): number {
	const seconds = Number(process.env[name] ?? fallbackSeconds);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

const IDLE_MS = envDelayMs("OMP_CLIPCAP_IDLE_SECONDS", 5);

const AUTO_MS = envDelayMs("OMP_CLIPCAP_AUTO_SECONDS", 5);

const RECAP_WIDGET = "clipcap:recap";

/** Fallback band past the earlier bands */
const LAST_BAND: { untilMin: number; everyMin: number } = { untilMin: Number.POSITIVE_INFINITY, everyMin: 15 };

/** Refresh cadence by time worked; first band where elapsed < untilMin wins */
const REFRESH_SCHEDULE: readonly { untilMin: number; everyMin: number }[] = [
	{ untilMin: 12, everyMin: 3 },
	{ untilMin: 30, everyMin: 6 },
	{ untilMin: 60, everyMin: 10 },
	LAST_BAND,
];

function refreshDelayMs(elapsedMs: number): number {
	const min = elapsedMs / 60_000;
	const band = REFRESH_SCHEDULE.find(b => min < b.untilMin) ?? LAST_BAND;
	return band.everyMin * 60_000;
}

const REPAINT_INTERVAL_MS = 30_000;

const CANCEL_HINT: WidthVariants = { full: "esc: cancel", brief: "esc: cancel" };

const VIEW_KEY = process.env.OMP_CLIPCAP_KEY ?? "ctrl-h";

/** Ctrl+<letter>: control byte on legacy terminals, CSI <cp>;5u in kitty */
function ctrlKeys(key: string): string[] {
	const letter = /^ctrl\s*[+-]?\s*(\w)$/i.exec(key.trim())?.[1];
	if (!letter) return [];
	const code = letter.toLowerCase().charCodeAt(0);
	return [String.fromCharCode(code & 0x1f), `\x1b[${code};5u`];
}

const VIEW_KEYS = ctrlKeys(VIEW_KEY);

const USER_NAME = userName();

/** Sticks across recaps and sessions */
let viewMode: ViewMode = "default";

let workStartedAt: number | undefined;

let settledWorkMs: number | undefined;

/** Live mid-turn, frozen after, empty without a turn */
function elapsedPhrase(): string {
	if (workStartedAt !== undefined) return formatElapsed(Date.now() - workStartedAt);
	return settledWorkMs === undefined ? "" : formatElapsed(settledWorkMs);
}

interface WidthVariants {
	full: string;
	brief: string;
}

/** Names the mode the view key moves to; brief is the bare key */
function viewHint(hasExtras: boolean): WidthVariants {
	if (!VIEW_KEYS.length) return { full: "", brief: "" };
	const next = nextViewMode(viewMode, hasExtras);
	const label = next === "expanded" ? "more" : next === "compact" ? "compact" : "full";
	return { full: `${VIEW_KEY}: ${label}`, brief: VIEW_KEY };
}

/** E.g. `<1m`, `7m`, `1h 5m` */
function formatElapsed(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const rest = minutes % 60;
	return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${minutes / 60}h`;
}

type SideTurnHost = ExtensionContext & { runEphemeralTurn: NonNullable<ExtensionContext["runEphemeralTurn"]> };

function hasSideTurn(ctx: ExtensionContext): ctx is SideTurnHost {
	return typeof ctx.runEphemeralTurn === "function";
}

/** Main session in the TUI */
function canPaintRecap(ctx: ExtensionContext): boolean {
	// Subagent sessions load this factory too, without a UI
	return ctx.agent.kind === "main" && ctx.mode === "tui";
}

/** Idle with nothing queued */
function sessionSettled(ctx: ExtensionContext): boolean {
	return canPaintRecap(ctx) && ctx.isIdle() && !ctx.hasPendingMessages();
}

/** Settled with an empty editor */
function isQuiet(ctx: ExtensionContext): boolean {
	return sessionSettled(ctx) && !ctx.ui.getEditorText().trim();
}

const HEADER_GAP = 2;

const METER_CELLS = 10;

/** Title left; meter, time, glyph right. The title is read per render */
export class HeaderRow implements Component {
	constructor(
		private readonly title: () => string,
		private readonly tail: WidthVariants,
	) { }

	invalidate(): void { }

	render(width: number): readonly string[] {
		const title = this.title();
		const titleWidth = visibleWidth(title);
		for (const source of [this.tail.full, this.tail.brief]) {
			const tail = truncateToWidth(source, width);
			const tailWidth = visibleWidth(tail);
			if (!tail) return [truncateToWidth(title, width)];
			if (!title) return [`${" ".repeat(Math.max(0, width - tailWidth))}${tail}`];
			const room = width - tailWidth - HEADER_GAP;
			if (room < Math.min(titleWidth, width / 3)) continue;
			const fitted = truncateToWidth(title, room);
			return [`${fitted}${" ".repeat(width - visibleWidth(fitted) - tailWidth)}${tail}`];
		}
		const tail = truncateToWidth(this.tail.brief, width);
		return [truncateToWidth(title, width), `${" ".repeat(Math.max(0, width - visibleWidth(tail)))}${tail}`];
	}
}

const HINT_TAIL_CELLS = 3;

/** Panel border: `rounded` box, or `none` for bare content */
type BorderStyle = "rounded" | "none";

/** Unknown values fall back to none */
const BORDER: BorderStyle = process.env.OMP_CLIPCAP_BORDER?.trim().toLowerCase() === "rounded" ? "rounded" : "none";

/** `rule` cells of fill; the hint sits right, HINT_TAIL_CELLS from the end */
function hintRule(hint: WidthVariants, rule: number, fill: string): string {
	const fits = (text: string) => visibleWidth(text) + 2 + HINT_TAIL_CELLS <= rule;
	const text = [hint.full, hint.brief].find(fits);
	return text
		? `${fill.repeat(rule - visibleWidth(text) - 2 - HINT_TAIL_CELLS)} ${text} ${fill.repeat(HINT_TAIL_CELLS)}`
		: fill.repeat(rule);
}

/** Padded child; hint rides the bottom row, a rule when rounded */
class PanelFrame implements Component {
	constructor(
		private readonly child: Component,
		private readonly paint: (text: string) => string,
		private readonly hint: WidthVariants,
		private readonly border: BorderStyle,
	) { }

	invalidate(): void {
		this.child.invalidate?.();
	}

	render(width: number): readonly string[] {
		if (width < 5) return this.child.render(width);
		const rounded = this.border === "rounded";
		const inner = width - (rounded ? 4 : 0);
		const left = rounded ? this.paint("│ ") : "";
		const right = rounded ? this.paint(" │") : "";
		const rows = this.child.render(inner).map(line => {
			const fitted = truncateToWidth(line, inner);
			return `${left}${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))}${right}`;
		});
		if (!rounded) return [...rows, this.paint(hintRule(this.hint, inner, " "))];
		return [this.paint(`╭${"─".repeat(width - 2)}╮`), ...rows, this.paint(`╰${hintRule(this.hint, width - 2, "─")}╯`)];
	}
}

/** Mascot rows: head, shoulders, legs, feet */
const MASCOT = { head: "╭👀╮", shoulders: "│╭╮│", legs: "││││", feet: "╰─╯ " };

const MASCOT_WIDTH = visibleWidth(MASCOT.head) + 1;

/** Mascot left of child; head first row, feet last */
class MascotGutter implements Component {
	constructor(
		private readonly child: Component,
		private readonly paint: (text: string) => string,
	) { }

	invalidate(): void {
		this.child.invalidate?.();
	}

	render(width: number): readonly string[] {
		if (width < MASCOT_WIDTH * 3) return this.child.render(width);
		const rows = this.child.render(width - MASCOT_WIDTH);
		const last = rows.length - 1;
		return rows.map((row, i) => {
			const part = i === 0 ? MASCOT.head : i === last ? MASCOT.feet : i === 1 ? MASCOT.shoulders : MASCOT.legs;
			return `${this.paint(part)} ${row}`;
		});
	}
}

/** Compact mode: one row, no mascot or border; parts are read per render */
class CompactRow implements Component {
	constructor(private readonly line: (width: number) => string) { }

	invalidate(): void { }

	render(width: number): readonly string[] {
		return [this.line(width)];
	}
}

const HEADING_TONE: Record<RecapStatus, ThemeColor> = {
	done: "success",
	active: "accent",
	blocked: "warning",
};

const WORKING_ICON = "⌛";

const GREETING_ICON = "👋";

interface PanelView {
	/** Read per render, so the greeting tracks the clock */
	title: () => string;
	body: string;
	hint: WidthVariants;
	status?: RecapStatus;
	progress?: number;
	icon?: string;
	updating?: boolean;
	/** Compact-line parts, read per render */
	compact: () => CompactParts;
}

/** Panel above the editor, laid out for the current view mode */
function showPanel(ctx: ExtensionContext, view: PanelView): void {
	ctx.ui.setWidget(RECAP_WIDGET, (_tui, theme) => {
		const dim = (text: string) => theme.fg("dim", text);
		const tone = view.status ? HEADING_TONE[view.status] : "thinkingText";
		// Leave one empty cell so the meter never reads full
		const filled = view.progress === undefined
			? 0
			: Math.min(METER_CELLS - 1, Math.max(1, Math.round((view.progress / 100) * METER_CELLS)));
		const meter = view.progress === undefined
			? ""
			: `${theme.fg(tone, "━".repeat(filled))}${theme.fg("dim", "┄".repeat(METER_CELLS - filled))}`;
		const elapsed = [elapsedPhrase(), view.updating && "(updating…)"].filter(Boolean).join(" ");
		if (viewMode === "compact") {
			return new CompactRow(width => {
				const parts = view.compact();
				return fitCompact(
					{
						icon: parts.icon,
						// Styling an empty title leaves escape codes that read as a title
						title: parts.title && theme.fg(tone, parts.title),
						request: parts.request && dim(parts.request),
						outcome: parts.outcome && theme.fg("thinkingText", parts.outcome),
						meter,
						elapsed: elapsed && dim(elapsed),
						hint: view.hint.brief && dim(view.hint.brief),
					},
					width,
					dim,
				);
			});
		}
		const tail = [elapsed && dim(elapsed), view.icon].filter(Boolean).join(" ");
		const panel = new Container();
		panel.addChild(
			new HeaderRow(
				() => {
					const title = view.title();
					// Styling an empty title leaves escape codes HeaderRow reads as a title
					return title && theme.fg(tone, title);
				},
				{ full: [meter, tail].filter(Boolean).join(" "), brief: tail },
			),
		);
		const body = view.body
			? new Markdown(view.body, 0, 0, getMarkdownTheme(), {
				color: text => theme.fg("thinkingText", text),
			})
			: undefined;
		if (body) panel.addChild(body);
		return new MascotGutter(new PanelFrame(panel, dim, view.hint, BORDER), dim);
	});
}

/** Recap shown, with the prompt that refreshes it */
interface ShownRecap {
	promptText: string;
	replay: Replay;
}

/** What the panel shows when no asked recap is in flight */
type SettledPanel =
	| { kind: "greeting" }
	/** Submitted; no recap for this turn yet */
	| { kind: "pending"; request: string }
	| { kind: "recap"; shown: ShownRecap };

/** Always painted in the main TUI session; never hidden */
type PanelState = SettledPanel | { kind: "recapping"; previous: SettledPanel };

function paintPanel(ctx: ExtensionContext, state: PanelState, updating: boolean): void {
	switch (state.kind) {
		case "greeting": {
			const title = () => greetingText(new Date().getHours(), USER_NAME);
			showPanel(ctx, {
				title,
				body: "",
				hint: viewHint(false),
				compact: () => ({ icon: GREETING_ICON, title: title() }),
			});
			return;
		}
		case "pending": {
			const title = `You asked: ${state.request}`;
			showPanel(ctx, {
				title: () => title,
				body: "",
				hint: viewHint(false),
				icon: WORKING_ICON,
				compact: () => ({ icon: WORKING_ICON, title }),
			});
			return;
		}
		case "recapping":
			showPanel(ctx, {
				title: () => "recapping…",
				body: "",
				hint: CANCEL_HINT,
				compact: () => ({ icon: WORKING_ICON, title: "recapping…" }),
			});
			return;
		case "recap": {
			const { replay } = state.shown;
			const parts = compactParts(replay);
			showPanel(ctx, {
				title: () => replay.title ?? "",
				body: viewMode === "expanded" && replay.expanded ? replay.expanded : replay.markdown,
				hint: viewHint((replay.extras?.length ?? 0) > 0),
				status: replay.status,
				progress: replay.progress,
				icon: replay.icon,
				updating,
				compact: () => parts,
			});
			return;
		}
	}
}

/** True when the session holds a user or assistant message */
function hasHistory(ctx: ExtensionContext): boolean {
	return ctx.sessionManager
		.getBranch()
		.some(entry => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));
}

type RecapMode = "idle" | "asked" | "refresh" | "auto";

function recapStillWanted(mode: RecapMode, current: ExtensionContext): boolean {
	if (!canPaintRecap(current)) return false;
	if (mode === "idle") return isQuiet(current);
	if (mode === "auto") return workStartedAt !== undefined;
	return true;
}

/** In-flight recap; a new run supersedes it */
interface RecapRunner {
	run(ctx: SideTurnHost, promptText: string, mode: RecapMode, assumed: AssumedStatus): Promise<Replay | undefined>;
	/** userActivity spares asked recaps */
	cancel(userActivity: boolean): void;
	busy(): boolean;
}

function recapRunner(): RecapRunner {
	let running: { abort: AbortController; speculative: boolean } | undefined;

	const cancel = (userActivity: boolean): void => {
		if (!running) return;
		if (userActivity && !running.speculative) return;
		running.abort.abort();
		running = undefined;
	};

	const run = async (
		current: SideTurnHost,
		promptText: string,
		mode: RecapMode,
		assumed: AssumedStatus,
	): Promise<Replay | undefined> => {
		cancel(false);
		const abort = new AbortController();
		const speculative = mode === "idle" || mode === "auto";
		running = { abort, speculative };
		try {
			const { replyText } = await current.runEphemeralTurn({
				promptText,
				signal: abort.signal,
				// The reply is one JSON object; line collapsing or the byte cap could mangle it
				dedupeReply: false,
				replyMaxBytes: Number.POSITIVE_INFINITY,
			});
			if (abort.signal.aborted) return undefined;
			if (!recapStillWanted(mode, current)) return undefined;
			return replayRecap(replyText, assumed);
		} catch (error) {
			if (!abort.signal.aborted && mode === "asked") {
				current.ui.notify(`/clipcap: recap failed (${error instanceof Error ? error.message : String(error)})`, "warning");
			}
			return undefined;
		} finally {
			if (running?.abort === abort) running = undefined;
		}
	};

	return { run, cancel, busy: () => running !== undefined };
}

interface RecapLifecycle {
	/** /clipcap: recap now; failure or esc restores the previous view */
	ask(ctx: SideTurnHost, promptText: string): Promise<void>;
}

interface RefreshState {
	shown: ShownRecap;
	nextAt: number;
	timer?: { cancel(): void };
}

function wireRecapLifecycle(pi: ExtensionAPI, recap: RecapRunner): RecapLifecycle {
	const idleEnabled = IDLE_MS > 0;

	let ctx: ExtensionContext | undefined;
	let clock: { cancel(): void } | undefined;
	let autoClock: { cancel(): void } | undefined;
	let armed = false;
	let panel: PanelState = { kind: "greeting" };
	let refresh: RefreshState | undefined;
	let stopListening: (() => void) | undefined;

	/** Repaints the current state; a recap with a run in flight reads as updating */
	const paint = (current: ExtensionContext) => {
		if (!canPaintRecap(current)) return;
		paintPanel(current, panel, panel.kind === "recap" && recap.busy());
	};

	const shownRecap = (): ShownRecap | undefined => (panel.kind === "recap" ? panel.shown : undefined);

	const stopClock = () => {
		clock?.cancel();
		clock = undefined;
	};

	const stopRefresh = () => {
		refresh?.timer?.cancel();
		refresh = undefined;
	};

	const nextRefreshAt = (): number => {
		const now = Date.now();
		return now + refreshDelayMs(now - (workStartedAt ?? now));
	};

	const scheduleTick = (current: ExtensionContext, state: RefreshState) => {
		const id = current.setTimeout(() => void tick(state), REPAINT_INTERVAL_MS);
		state.timer = { cancel: () => current.clearTimer(id) };
	};

	const tick = async (state: RefreshState): Promise<void> => {
		state.timer = undefined;
		const current = ctx;
		if (refresh !== state || !current) return;
		if (sessionSettled(current)) {
			stopRefresh();
			paint(current);
			return;
		}
		if (Date.now() >= state.nextAt) {
			if (!hasSideTurn(current)) {
				stopRefresh();
				return;
			}
			const running = recap.run(current, state.shown.promptText, "refresh", "active");
			paint(current);
			const replay = await running;
			if (refresh !== state) return;
			if (replay) state.shown.replay = replay;
			state.nextAt = nextRefreshAt();
		}
		paint(current);
		scheduleTick(current, state);
	};

	const startRefresh = (current: SideTurnHost, promptText: string, replay: Replay) => {
		stopRefresh();
		const shown: ShownRecap = { promptText, replay };
		panel = { kind: "recap", shown };
		paint(current);
		// Settled already: the recap ran as done, and agent_end gives any later turn its final refresh
		if (sessionSettled(current)) return;
		ctx ??= current;
		const state: RefreshState = { shown, nextAt: nextRefreshAt() };
		refresh = state;
		scheduleTick(current, state);
	};

	const finalRefresh = async (current: ExtensionContext, state: ShownRecap): Promise<void> => {
		if (!hasSideTurn(current)) {
			paint(current);
			return;
		}
		const running = recap.run(current, state.promptText, "refresh", "done");
		paint(current);
		const replay = await running;
		if (shownRecap() !== state) return;
		if (replay) state.replay = replay;
		paint(current);
	};

	const ask = async (current: SideTurnHost, promptText: string): Promise<void> => {
		stopRefresh();
		const previous = panel.kind === "recapping" ? panel.previous : panel;
		const asking: PanelState = { kind: "recapping", previous };
		panel = asking;
		const assumed: AssumedStatus = current.isIdle() && !current.hasPendingMessages() ? "done" : "active";
		const running = recap.run(current, promptText, "asked", assumed);
		paint(current);
		const replay = await running;
		if (replay) {
			startRefresh(current, promptText, replay);
			return;
		}
		// A newer /clipcap or input owns the panel now
		if (panel !== asking) return;
		panel = previous;
		paint(current);
	};

	/** An idle or auto recap is wanted only before this turn has one */
	const awaitingRecap = () => panel.kind === "greeting" || panel.kind === "pending";

	const fire = () => {
		clock = undefined;
		const current = ctx;
		if (!current || !armed) return;
		armed = false;
		if (!awaitingRecap() || recap.busy() || !isQuiet(current)) return;
		if (!hasSideTurn(current)) {
			current.ui.notify("/clipcap: this host has no runEphemeralTurn; idle recaps are off.", "warning");
			return;
		}
		void recap.run(current, RECAP_PROMPT, "idle", "done").then(replay => {
			if (!replay || !awaitingRecap()) return;
			panel = { kind: "recap", shown: { promptText: RECAP_PROMPT, replay } };
			paint(current);
		});
	};

	const restartClock = () => {
		stopClock();
		if (!idleEnabled || !armed || !ctx) return;
		const current = ctx;
		const id = current.setTimeout(fire, IDLE_MS);
		clock = { cancel: () => current.clearTimer(id) };
	};

	const stopAuto = () => {
		autoClock?.cancel();
		autoClock = undefined;
	};

	const fireAuto = () => {
		autoClock = undefined;
		const current = ctx;
		if (!current || workStartedAt === undefined) return;
		if (!awaitingRecap() || recap.busy() || !hasSideTurn(current)) return;
		void recap.run(current, RECAP_PROMPT, "auto", "active").then(replay => {
			if (!replay || workStartedAt === undefined || !awaitingRecap()) return;
			startRefresh(current, RECAP_PROMPT, replay);
		});
	};

	const armAuto = (current: ExtensionContext) => {
		stopAuto();
		if (!AUTO_MS) return;
		const id = current.setTimeout(fireAuto, AUTO_MS);
		autoClock = { cancel: () => current.clearTimer(id) };
	};

	const adopt = (sessionCtx: ExtensionContext) => {
		if (sessionCtx.agent.kind !== "main") return;
		ctx = sessionCtx;
		workStartedAt = undefined;
		settledWorkMs = undefined;
		stopClock();
		stopAuto();
		stopRefresh();
		recap.cancel(false);
		panel = { kind: "greeting" };
		paint(sessionCtx);
		// A resumed conversation gets its recap once the session goes quiet
		armed = hasHistory(sessionCtx);
		restartClock();
		stopListening?.();
		stopListening = sessionCtx.ui.onTerminalInput(data => {
			if (VIEW_KEYS.includes(data)) {
				viewMode = nextViewMode(viewMode, (shownRecap()?.replay.extras?.length ?? 0) > 0);
				paint(sessionCtx);
				return { consume: true };
			}
			// esc cancels only an asked recap, which ask() then restores; refreshes run on so the recap stays current
			const escape = data === "\x1b" || data === "\x1b[27u";
			recap.cancel(!(escape && panel.kind === "recapping"));
			restartClock();
		});
	};

	pi.on("session_start", (_event, sessionCtx) => adopt(sessionCtx));
	pi.on("session_switch", (_event, sessionCtx) => adopt(sessionCtx));
	// The shown recap would describe the branch left behind
	pi.on("session_tree", (_event, sessionCtx) => adopt(sessionCtx));
	pi.on("session_branch", (_event, sessionCtx) => adopt(sessionCtx));
	pi.on("agent_start", (_event, sessionCtx) => {
		if (sessionCtx.agent.kind !== "main") return;
		ctx = sessionCtx;
		workStartedAt = Date.now();
		settledWorkMs = undefined;
		recap.cancel(true);
		armAuto(sessionCtx);
		// The placeholder painted before the turn had a start time
		if (panel.kind === "pending") paint(sessionCtx);
	});
	pi.on("agent_end", (_event, sessionCtx) => {
		if (sessionCtx.agent.kind !== "main") return;
		ctx = sessionCtx;
		stopAuto();
		settledWorkMs = workStartedAt === undefined ? undefined : Date.now() - workStartedAt;
		workStartedAt = undefined;
		stopRefresh();
		const shown = shownRecap();
		if (shown) void finalRefresh(sessionCtx, shown);
		else paint(sessionCtx);
		armed = true;
		restartClock();
	});
	pi.on("input", (event, sessionCtx) => {
		if (sessionCtx.agent.kind !== "main") return;
		ctx = sessionCtx;
		recap.cancel(true);
		// A submit that starts no turn (slash or bang command) must not arm; agent_end re-arms
		armed = false;
		stopClock();
		const text = event.text.trim();
		if (text.startsWith("/") || text.startsWith("!")) return;
		stopRefresh();
		panel = { kind: "pending", request: text.split("\n")[0] || "…" };
		paint(sessionCtx);
	});

	return { ask };
}

export default function clipcapExtension(pi: ExtensionAPI) {
	pi.setLabel("/clipcap — recap");

	const lifecycle = wireRecapLifecycle(pi, recapRunner());

	pi.registerCommand("clipcap", {
		description: "Recap this conversation in the panel above the editor",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/clipcap needs the interactive TUI.", "warning");
				return;
			}
			if (!hasSideTurn(ctx)) {
				ctx.ui.notify("/clipcap: this host has no runEphemeralTurn; recaps are off.", "warning");
				return;
			}

			const focus = args.trim();
			await lifecycle.ask(ctx, focus ? `${RECAP_PROMPT}\n\n${focus}` : RECAP_PROMPT);
		},
	});
}

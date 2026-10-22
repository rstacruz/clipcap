import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getMarkdownTheme } from "@oh-my-pi/pi-coding-agent";
import { type Component, Container, Markdown, type ThemeColor, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { RECAP_PROMPT, replayRecap, type AssumedStatus, type RecapStatus, type Replay } from "./recap.ts";

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

/** Footer hint, first */
const DISMISS_HINT = "esc: dismiss";

const CANCEL_HINT: WidthVariants = { full: "esc: cancel", brief: "esc: cancel" };

const DETAILS_KEY = process.env.OMP_CLIPCAP_KEY ?? "ctrl-h";

/** Ctrl+<letter>: control byte on legacy terminals, CSI <cp>;5u in kitty */
function detailsKeys(key: string): string[] {
	const letter = /^ctrl\s*[+-]?\s*(\w)$/i.exec(key.trim())?.[1];
	if (!letter) return [];
	const code = letter.toLowerCase().charCodeAt(0);
	return [String.fromCharCode(code & 0x1f), `\x1b[${code};5u`];
}

const DETAILS_KEYS = detailsKeys(DETAILS_KEY);

let detailsShown = false;

/** Expanded fields; empty means no details toggle */
let detailsExtras: string[] = [];

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

function recapHint(): WidthVariants {
	const details = detailsExtras.length > 0 ? `${DETAILS_KEY}: ${detailsShown ? "less" : "more"}` : "";
	return { full: [DISMISS_HINT, details].filter(Boolean).join(" · "), brief: DISMISS_HINT };
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

/** Title left; meter, time, glyph right */
export class HeaderRow implements Component {
	constructor(
		private readonly title: string,
		private readonly tail: WidthVariants,
	) { }

	invalidate(): void { }

	render(width: number): readonly string[] {
		const titleWidth = visibleWidth(this.title);
		for (const source of [this.tail.full, this.tail.brief]) {
			const tail = truncateToWidth(source, width);
			const tailWidth = visibleWidth(tail);
			if (!tail) return [truncateToWidth(this.title, width)];
			if (!this.title) return [`${" ".repeat(Math.max(0, width - tailWidth))}${tail}`];
			const room = width - tailWidth - HEADER_GAP;
			if (room < Math.min(titleWidth, width / 3)) continue;
			const fitted = truncateToWidth(this.title, room);
			return [`${fitted}${" ".repeat(width - visibleWidth(fitted) - tailWidth)}${tail}`];
		}
		const tail = truncateToWidth(this.tail.brief, width);
		return [truncateToWidth(this.title, width), `${" ".repeat(Math.max(0, width - visibleWidth(tail)))}${tail}`];
	}
}

const HINT_TAIL_CELLS = 3;

/** Rounded frame; hint rides the bottom rule */
class RoundedFrame implements Component {
	constructor(
		private readonly child: Component,
		private readonly paint: (text: string) => string,
		private readonly hint: WidthVariants,
	) { }

	invalidate(): void {
		this.child.invalidate?.();
	}

	private bottom(rule: number): string {
		const fits = (text: string) => visibleWidth(text) + 2 + HINT_TAIL_CELLS <= rule;
		const hint = [this.hint.full, this.hint.brief].find(fits);
		return hint
			? `${"─".repeat(rule - visibleWidth(hint) - 2 - HINT_TAIL_CELLS)} ${hint} ${"─".repeat(HINT_TAIL_CELLS)}`
			: "─".repeat(rule);
	}

	render(width: number): readonly string[] {
		if (width < 5) return this.child.render(width);
		const inner = width - 4;
		const left = this.paint("│ ");
		const right = this.paint(" │");
		const rows = this.child.render(inner).map(line => {
			const fitted = truncateToWidth(line, inner);
			return `${left}${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))}${right}`;
		});
		return [this.paint(`╭${"─".repeat(width - 2)}╮`), ...rows, this.paint(`╰${this.bottom(width - 2)}╯`)];
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
			const part = i === 0 ? MASCOT.head : i === 1 ? MASCOT.shoulders : i === last ? MASCOT.feet : MASCOT.legs;
			return `${this.paint(part)} ${row}`;
		});
	}
}

const HEADING_TONE: Record<RecapStatus, ThemeColor> = {
	done: "success",
	active: "accent",
	blocked: "warning",
};

interface PanelView {
	title: string;
	body: string;
	hint: WidthVariants;
	status?: RecapStatus;
	progress?: number;
	icon?: string;
	updating?: boolean;
}

/** Recap panel above the editor */
function showRecapPanel(ctx: ExtensionContext, view: PanelView): void {
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
		const tail = [elapsed && dim(elapsed), view.icon].filter(Boolean).join(" ");
		const panel = new Container();
		// Styling an empty title leaves escape codes HeaderRow reads as a title
		panel.addChild(
			new HeaderRow(view.title && theme.fg(tone, view.title), {
				full: [meter, tail].filter(Boolean).join(" "),
				brief: tail,
			}),
		);
		const body = view.body
			? new Markdown(view.body, 0, 0, getMarkdownTheme(), {
				color: text => theme.fg("thinkingText", text),
			})
			: undefined;
		if (body) panel.addChild(body);
		return new MascotGutter(new RoundedFrame(panel, dim, view.hint), dim);
	});
}

/** Shows replay; keepDetails preserves an expanded panel */
function activatePanel(current: ExtensionContext, replay: Replay, keepDetails: boolean, updating = false): void {
	detailsExtras = replay.extras ?? [];
	if (!keepDetails) detailsShown = false;
	showRecapPanel(current, {
		title: replay.title ?? "",
		body: detailsShown && replay.expanded ? replay.expanded : replay.markdown,
		hint: recapHint(),
		status: replay.status,
		progress: replay.progress,
		icon: replay.icon,
		updating,
	});
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
		let answered = false;
		if (mode === "asked") showRecapPanel(current, { title: "recapping…", body: "", hint: CANCEL_HINT });
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
			const replay = replayRecap(replyText, assumed);
			if (!replay) return undefined;
			if (mode !== "refresh" && mode !== "auto") activatePanel(current, replay, false);
			answered = true;
			return replay;
		} catch (error) {
			if (!abort.signal.aborted && mode === "asked") {
				current.ui.notify(`/clipcap: recap failed (${error instanceof Error ? error.message : String(error)})`, "warning");
			}
			return undefined;
		} finally {
			if (running?.abort === abort) {
				running = undefined;
				if (mode === "asked" && !answered) current.ui.setWidget(RECAP_WIDGET, undefined);
			}
		}
	};

	return { run, cancel, busy: () => running !== undefined };
}

interface RecapRefresher {
	start(ctx: SideTurnHost, promptText: string, replay: Replay): void;
	/** Stop refreshing; /clipcap repaints the block */
	stop(): void;
}

interface ShownRecap {
	promptText: string;
	replay: Replay;
}

interface RefreshState {
	shown: ShownRecap;
	nextAt: number;
	timer?: { cancel(): void };
}

function wireRecapLifecycle(pi: ExtensionAPI, recap: RecapRunner): RecapRefresher {
	const idleEnabled = IDLE_MS > 0;

	let ctx: ExtensionContext | undefined;
	let clock: { cancel(): void } | undefined;
	let autoClock: { cancel(): void } | undefined;
	let armed = false;
	let shown: ShownRecap | undefined;
	let refresh: RefreshState | undefined;

	const stopClock = () => {
		clock?.cancel();
		clock = undefined;
	};

	const stopRefresh = () => {
		refresh?.timer?.cancel();
		refresh = undefined;
	};

	const hidePanel = (current: ExtensionContext) => {
		stopRefresh();
		shown = undefined;
		current.ui.setWidget(RECAP_WIDGET, undefined);
	};

	const nextRefreshAt = (): number => {
		const now = Date.now();
		return now + refreshDelayMs(now - (workStartedAt ?? now));
	};

	const paintRefresh = (current: ExtensionContext, state: RefreshState, updating = false) => {
		activatePanel(current, state.shown.replay, true, updating);
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
			activatePanel(current, state.shown.replay, true);
			return;
		}
		if (Date.now() >= state.nextAt) {
			if (!hasSideTurn(current)) {
				stopRefresh();
				return;
			}
			paintRefresh(current, state, true);
			const replay = await recap.run(current, state.shown.promptText, "refresh", "active");
			if (refresh !== state) return;
			if (replay) state.shown.replay = replay;
			state.nextAt = nextRefreshAt();
		}
		paintRefresh(current, state);
		scheduleTick(current, state);
	};

	const startRefresh = (current: SideTurnHost, promptText: string, replay: Replay) => {
		stopRefresh();
		shown = { promptText, replay };
		// Settled already: the recap ran as done, and agent_end gives any later turn its final refresh
		if (sessionSettled(current)) return;
		ctx ??= current;
		const state: RefreshState = { shown, nextAt: nextRefreshAt() };
		refresh = state;
		paintRefresh(current, state);
		scheduleTick(current, state);
	};

	const forgetPanel = () => {
		stopRefresh();
		shown = undefined;
	};

	const finalRefresh = async (current: ExtensionContext, state: ShownRecap): Promise<void> => {
		if (!hasSideTurn(current)) {
			activatePanel(current, state.replay, true);
			return;
		}
		activatePanel(current, state.replay, true, true);
		const replay = await recap.run(current, state.promptText, "refresh", "done");
		if (shown !== state) return;
		if (replay) state.replay = replay;
		activatePanel(current, state.replay, true);
	};

	const fire = () => {
		clock = undefined;
		const current = ctx;
		if (!current || !armed) return;
		armed = false;
		if (shown || !isQuiet(current)) return;
		if (!hasSideTurn(current)) {
			current.ui.notify("/clipcap: this host has no runEphemeralTurn; idle recaps are off.", "warning");
			return;
		}
		void recap.run(current, RECAP_PROMPT, "idle", "done").then(replay => {
			if (!replay) return;
			shown = { promptText: RECAP_PROMPT, replay };
			activatePanel(current, replay, false);
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
		if (shown || recap.busy() || !hasSideTurn(current)) return;
		void recap.run(current, RECAP_PROMPT, "auto", "active").then(replay => {
			if (!replay || workStartedAt === undefined) return;
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
		armed = false;
		workStartedAt = undefined;
		settledWorkMs = undefined;
		stopClock();
		stopAuto();
		recap.cancel(false);
		hidePanel(sessionCtx);
		sessionCtx.ui.onTerminalInput(data => {
			const escape = data === "\x1b" || data === "\x1b[27u";
			if (DETAILS_KEYS.includes(data) && shown && detailsExtras.length > 0) {
				detailsShown = !detailsShown;
				activatePanel(sessionCtx, shown.replay, true);
				return { consume: true };
			}
			recap.cancel(!escape);
			if (escape) {
				hidePanel(sessionCtx);
				armed = false;
			}
			restartClock();
		});
	};

	pi.on("session_start", (_event, sessionCtx) => adopt(sessionCtx));
	pi.on("session_switch", (_event, sessionCtx) => adopt(sessionCtx));
	pi.on("agent_start", (_event, sessionCtx) => {
		if (sessionCtx.agent.kind !== "main") return;
		ctx = sessionCtx;
		workStartedAt = Date.now();
		settledWorkMs = undefined;
		recap.cancel(true);
		armAuto(sessionCtx);
	});
	pi.on("agent_end", (_event, sessionCtx) => {
		if (sessionCtx.agent.kind !== "main") return;
		ctx = sessionCtx;
		stopAuto();
		settledWorkMs = workStartedAt === undefined ? undefined : Date.now() - workStartedAt;
		workStartedAt = undefined;
		stopRefresh();
		if (shown) void finalRefresh(sessionCtx, shown);
		armed = true;
		restartClock();
	});
	pi.on("input", (_event, sessionCtx) => {
		if (sessionCtx.agent.kind !== "main") return;
		ctx = sessionCtx;
		recap.cancel(true);
		hidePanel(sessionCtx);
		armed = true;
		restartClock();
	});

	return { start: startRefresh, stop: forgetPanel };
}

export default function clipcapExtension(pi: ExtensionAPI) {
	pi.setLabel("/clipcap — recap");

	const recap = recapRunner();
	const refresher = wireRecapLifecycle(pi, recap);

	pi.registerCommand("clipcap", {
		description: "Recap this conversation as a dim block above the editor",
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
			const promptText = focus ? `${RECAP_PROMPT}\n\n${focus}` : RECAP_PROMPT;
			refresher.stop();
			const assumed: AssumedStatus = ctx.isIdle() && !ctx.hasPendingMessages() ? "done" : "active";
			const replay = await recap.run(ctx, promptText, "asked", assumed);
			if (replay) refresher.start(ctx, promptText, replay);
		},
	});
}

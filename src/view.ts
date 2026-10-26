import { userInfo } from "node:os";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Recap, RecapStatus, Replay } from "./recap.ts";

/** Panel layouts `ctrl-h` cycles through */
export type ViewMode = "default" | "expanded" | "compact";

/** default → expanded → compact; expanded only with details to show */
export function nextViewMode(mode: ViewMode, hasExtras: boolean): ViewMode {
	if (mode === "default") return hasExtras ? "expanded" : "compact";
	if (mode === "expanded") return "compact";
	return "default";
}

/** E.g. `Good morning, rsc` */
export function greetingText(hour: number, name: string | undefined): string {
	const part = hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : "evening";
	return name ? `Good ${part}, ${name}` : `Good ${part}`;
}

/** whoami, without a subprocess */
export function userName(): string | undefined {
	try {
		return userInfo().username || undefined;
	} catch {
		return process.env.USER || undefined;
	}
}

/** One line of model text; empty counts as omitted */
function oneLine(value: string | undefined): string | undefined {
	const line = value?.replace(/\s+/g, " ").trim();
	return line ? line : undefined;
}

/** Text parts of the compact line */
export interface CompactParts {
	icon?: string;
	title?: string;
	request?: string;
	outcome?: string;
}

/** Outcome by status: active → so far / next, done → answer / did, blocked → ask */
function compactOutcome(recap: Recap, status: RecapStatus | undefined): string | undefined {
	const answer = oneLine(recap.answer);
	const next = oneLine(Array.isArray(recap.next) ? recap.next.find(item => oneLine(item)) : recap.next);
	const active = answer ? `so far: ${answer}` : next && `next: ${next}`;
	if (status === "blocked") {
		const ask = oneLine(recap.ask);
		return ask ? `for you: ${ask}` : active;
	}
	if (status === "done") return answer ?? oneLine(recap.did);
	return active;
}

/** Compact-line parts; a reply without JSON leads with its first line */
export function compactParts(replay: Replay): CompactParts {
	const { recap } = replay;
	if (!recap) return { icon: replay.icon, title: oneLine(replay.markdown.split("\n").find(line => line.trim())) };
	return {
		icon: replay.icon,
		title: oneLine(replay.title),
		request: oneLine(recap.request),
		outcome: compactOutcome(recap, replay.status),
	};
}

/** Styled pieces of the compact line; meter, elapsed, and hint sit right */
export interface CompactPieces extends CompactParts {
	meter?: string;
	elapsed?: string;
	hint?: string;
}

const COMPACT_GAP = 2;

/** Pieces dropped, in order, until the line fits */
const DROP_ORDER = ["hint", "request", "meter", "outcome", "elapsed"] as const;

function composeCompact(pieces: CompactPieces, width: number, dim: (text: string) => string) {
	// Title leads; without one, the request leads and stays
	const lead = pieces.title ?? pieces.request ?? "";
	const request = pieces.title ? pieces.request : undefined;
	const outcomeJoin = !lead ? "" : request || !pieces.title ? dim(" → ") : dim(" · ");
	const fields = `${request ? `${dim(" · ")}${request}` : ""}${pieces.outcome ? `${outcomeJoin}${pieces.outcome}` : ""}`;
	const left = `${[pieces.icon, lead].filter(Boolean).join(" ")}${fields}`;
	const right = [pieces.meter, pieces.elapsed, pieces.hint].filter(Boolean).join(" ");
	if (!right) return { row: left, fits: visibleWidth(left) <= width };
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return { row: `${left}${" ".repeat(Math.max(COMPACT_GAP, gap))}${right}`, fits: gap >= COMPACT_GAP };
}

/**
 * One row: lead and its fields left; meter, elapsed, hint right.
 * Drops hint, request, meter, outcome, elapsed in turn, then shortens the lead.
 */
export function fitCompact(pieces: CompactPieces, width: number, dim: (text: string) => string = text => text): string {
	const kept: CompactPieces = { ...pieces };
	for (const drop of [undefined, ...DROP_ORDER]) {
		if (drop === "request" && !pieces.title) continue;
		if (drop) kept[drop] = undefined;
		const { row, fits } = composeCompact(kept, width, dim);
		if (fits) return row;
	}
	const icon = pieces.icon ? `${pieces.icon} ` : "";
	return `${icon}${truncateToWidth(pieces.title ?? pieces.request ?? "", Math.max(0, width - visibleWidth(icon)))}`;
}

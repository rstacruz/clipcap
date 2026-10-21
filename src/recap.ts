/** Recap prompt; `/clipcap` args are appended */
export const RECAP_PROMPT = `
Recap this convo so far. No tool calls, just use convo as context. Use Sentence case.

Reply with one JSON object and nothing else. Omit any field you have nothing to say for.

\`\`\`json
{
  "kind": "implement",
  "title": "Make clipcap emit structured recaps",
  "goal": "structured recap output",
  "progress": 40,
  "answer": "dedupeReply can mangle JSON",
  "ask": "pick schema field names",
  "note": ["runEphemeralTurn strips tool calls"],
  "next": ["rewrite RECAP_PROMPT"],
  "refs": [{ "title": "clipcap.ts", "url": "https://..." }]
}
\`\`\`

- blocked: true only when you need user input to fulfill the goal; pair it with ask. Omit otherwise.
- kind: debug, plan, answer (simple questions), investigate, research, review, triage, implement (when fresh), refine (when working on existing code), merge, deploy, monitor. Omit if not clear; the renderer picks the right tense.
- title: 5 words max. If kind=answer, phrase as question.
- goal: 7 words max. Omit when the title already states it.
- progress: 0-100, gut feel. Omit when done.
- answer: the outcome the convo is heading to — a direct answer when it answers a question, the finding when it investigates. 7 words max. Omit when not applicable.
- did: 7 words max, what was done. Still worth sending when the session did work worth naming; the panel hides it whenever answer exists. Omit when not worth mentioning.
- ask: 7 words max, what the user should do. Omit when not obvious.
- note: up to 2 findings, 5 words each. Phrase as "so far" progress.
- next: up to 2 items, 7 words each, what happens next. Omit when idle.
- refs: up to 3 relevant links (PR, ticket, file). Each needs a short title and a url.
`.trim();

/** Structured recap the model returns */
export interface Recap {
	/** Set when work cannot continue without user input */
	blocked?: boolean;
	kind?: string;
	title?: string;
	goal?: string;
	progress?: number;
	/** Question outcome or investigation finding */
	answer?: string;
	did?: string;
	ask?: string;
	note?: string | string[];
	next?: string | string[];
	refs?: { title: string; url: string }[];
}

/** Turn in flight, or settled */
export type AssumedStatus = "active" | "done";

/** Effective status: `blocked` outranks the caller's assumption */
export type RecapStatus = AssumedStatus | "blocked";

/** Fields the compact panel renders, in order */
const COMPACT_FIELDS = ["title", "goal", "answer", "did", "ask"];

/** Details view fields, in order */
const DETAIL_FIELDS = ["note", "next", "refs"];

const NOTE_LIMIT = 2;
const NEXT_LIMIT = 2;

const STATUS_ICONS: Record<string, string> = {
	done: "🟢",
	active: "⌛",
	blocked: "🖐️",
};

/** Category labels by tense: in progress, then done */
const KIND_LABELS: Record<string, [string, string]> = {
	debug: ["Debugging", "Debugged"],
	plan: ["Planning", "Planned"],
	answer: ["Answering", "Answered"],
	investigate: ["Investigating", "Investigated"],
	research: ["Researching", "Researched"],
	review: ["Reviewing", "Reviewed"],
	triage: ["Triaging", "Triaged"],
	implement: ["Implementing", "Implemented"],
	refine: ["Refining", "Refined"],
	merge: ["Merging", "Merged"],
	deploy: ["Deploying", "Deployed"],
	monitor: ["Monitoring", "Monitored"],
};

const CAPTIONS: Record<string, string> = {
	goal: "Goal",
	answer: "Result",
	did: "I did",
	ask: "For you",
	next: "Working on",
};

/** Payload of one rendered recap */
export interface Replay {
	recap?: Recap;
	/** Header line, e.g. "Merged: Ultramerge PR 16893" */
	title?: string;
	icon?: string;
	/** Effective status; tints the header */
	status?: RecapStatus;
	/** In-flight progress, 0-100; absent when done or out of range */
	progress?: number;
	markdown: string;
	/** Details markdown; falls back to markdown */
	expanded?: string;
	/** Expanded fields; empty means no details toggle */
	extras?: string[];
}

/** Empty or whitespace counts as omitted */
function trimField(value?: string): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** Strips bold, code, and link markup characters */
const escapeMarkdown = (text: string): string => text.replace(/[*`[\]]/g, "");

function isHttpUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

/** Recap JSON from a reply, fenced or wrapped in prose */
export function parseRecap(replyText: string): Recap | undefined {
	const unfenced = replyText.replace(/```[\w-]*\n([\s\S]*?)\n?```/g, "$1").trim();
	const start = unfenced.indexOf("{");
	const end = unfenced.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const value = JSON.parse(unfenced.slice(start, end + 1)) as Recap;
		return value !== null && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Header text, e.g. "Implementing: <title>" */
function recapHeadline(recap: Recap, title: string, status: string): string {
	const forms = KIND_LABELS[trimField(recap.kind)?.toLowerCase() ?? ""];
	const kind = forms?.[status === "done" ? 1 : 0];
	return kind ? `${kind}: ${title}` : title;
}

const SUMMARY_SLOT = "note";

/** Summary slot: the layout's own, else before next */
function summarySlotIn(fields: string[]): number {
	const slot = fields.indexOf(SUMMARY_SLOT);
	if (slot >= 0) return slot;
	const next = fields.indexOf("next");
	return next >= 0 ? next : fields.length;
}

/** Model may send one string instead of an array */
function asList(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

/** Recap blocks plus the fields that made it into them */
function buildRecap(recap: Recap, revealAll: boolean, assumed: AssumedStatus) {
	const blocks: string[] = [];
	const shown: string[] = [];
	const status: RecapStatus = recap.blocked === true ? "blocked" : assumed;
	const rawProgress = recap.progress ?? 0;
	const progress = status !== "done" && rawProgress > 0 && rawProgress < 100 ? rawProgress : undefined;
	const rawTitle = trimField(recap.title);
	const title = rawTitle && recapHeadline(recap, rawTitle, status);
	const did = trimField(recap.did);
	const wantsUser = status !== "active";
	const notes = asList(recap.note).filter(text => trimField(text)).slice(0, NOTE_LIMIT);
	const nexts = asList(recap.next).filter(text => trimField(text)).slice(0, NEXT_LIMIT);
	const fields = [...(revealAll ? DETAIL_ORDER : COMPACT_FIELDS)].filter(field => field !== "title");
	const linkedRefs = (recap.refs ?? []).flatMap(ref => {
		const refTitle = trimField(ref.title);
		const url = trimField(ref.url);
		return refTitle && url && isHttpUrl(url) ? [`[${escapeMarkdown(refTitle)}](${url})`] : [];
	});
	const summary = [
		...notes.map((text): string | undefined => `- ${escapeMarkdown(text)}`),
		...(fields.includes(SUMMARY_SLOT) ? linkedRefs.map((ref): string | undefined => `- ${ref}`) : []),
	].filter((block): block is string => block !== undefined);
	const answerCaption = status === "done" ? CAPTIONS.answer : "So far";
	const sections: Record<string, string | undefined> = {
		goal: trimField(recap.goal) && `- ${CAPTIONS.goal}: ${escapeMarkdown(trimField(recap.goal) ?? "")}`,
		answer: trimField(recap.answer) && `- ${answerCaption}: ${escapeMarkdown(trimField(recap.answer) ?? "")}`,
		did: !did || (!revealAll && trimField(recap.answer)) ? undefined : `- ${CAPTIONS.did}: ${escapeMarkdown(did)}`,
		ask:
			trimField(recap.ask) && (revealAll || wantsUser)
				? `- ${CAPTIONS.ask}: ${escapeMarkdown(trimField(recap.ask) ?? "")}`
				: undefined,
		[SUMMARY_SLOT]: summary.length ? summary.join("\n") : undefined,
		next: nexts.length ? `**Working on:**\n${nexts.map(text => `- ${escapeMarkdown(text)}`).join("\n")}` : undefined,
	};
	const inlineRef = !revealAll && linkedRefs.length && !fields.includes(SUMMARY_SLOT);
	if (summary.length && !fields.includes(SUMMARY_SLOT) && fields.includes("next")) {
		fields.splice(summarySlotIn(fields), 0, SUMMARY_SLOT);
	}
	for (const field of fields) {
		const block = sections[field];
		if (!block) continue;
		blocks.push(block);
		shown.push(field);
		if (field === SUMMARY_SLOT) {
			if (linkedRefs.length) shown.push("refs");
			if (inlineRef) shown.push("next");
		}
	}
	if (inlineRef) blocks.push(`- ${linkedRefs[0]}`);
	return { title, icon: STATUS_ICONS[status], status, progress, blocks, shown };
}

/** Recap body as markdown; revealAll renders the details view */
export function renderRecap(recap: Recap, revealAll = false, assumed: AssumedStatus = "done"): string {
	return buildRecap(recap, revealAll, assumed).blocks.join("\n");
}

/** Details view field order */
const DETAIL_ORDER = [...new Set([...COMPACT_FIELDS, ...DETAIL_FIELDS])];

/** Parses a reply into a replay; raw text without JSON */
export function replayRecap(replyText: string, assumed: AssumedStatus = "done"): Replay | undefined {
	const recap = parseRecap(replyText);
	if (!recap) {
		const raw = replyText.trim();
		return raw ? { markdown: raw } : undefined;
	}
	const compact = buildRecap(recap, false, assumed);
	const { title, icon, status, progress } = compact;
	const markdown = compact.blocks.join("\n");
	if (!title && !markdown) return undefined;
	const reveal = buildRecap(recap, true, assumed);
	const expanded = reveal.blocks.join("\n");
	const extras = DETAIL_FIELDS.filter(field => reveal.shown.includes(field));
	return { recap, title, icon, status, progress, markdown, expanded: extras.length ? expanded : markdown, extras };
}

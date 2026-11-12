import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { replayRecap } from "./recap.ts";
import { compactParts, fitCompact, greetingText, nextViewMode } from "./view.ts";

describe("nextViewMode", () => {
	test("cycles default, expanded, compact", () => {
		expect(nextViewMode("default", true)).toBe("expanded");
		expect(nextViewMode("expanded", true)).toBe("compact");
		expect(nextViewMode("compact", true)).toBe("default");
	});

	test("skips expanded when there is nothing more to show", () => {
		expect(nextViewMode("default", false)).toBe("compact");
	});
});

describe("greetingText", () => {
	test.each([
		[4, "Good evening, rsc"],
		[5, "Good morning, rsc"],
		[11, "Good morning, rsc"],
		[12, "Good afternoon, rsc"],
		[17, "Good afternoon, rsc"],
		[18, "Good evening, rsc"],
	])("greets hour %i with %s", (hour, text) => {
		expect(greetingText(hour, "rsc")).toBe(text);
	});

	test("drops the name when unknown", () => {
		expect(greetingText(9, undefined)).toBe("Good morning");
	});
});

describe("compactParts", () => {
	const reply = JSON.stringify({
		kind: "implement",
		title: "Wire recap into the panel",
		request: "show where the session stands",
		did: "split the prompt, renderer, and lifecycle",
		next: ["rewrite RECAP_PROMPT"],
		ask: "pick a one-line layout",
	});

	test("shows what is next while active, what was done once done", () => {
		const active = replayRecap(reply, "active");
		const done = replayRecap(reply, "done");
		expect(active && compactParts(active)).toEqual({
			icon: "⌛",
			title: "Implementing: Wire recap into the panel",
			request: "show where the session stands",
			outcome: "next: rewrite RECAP_PROMPT",
		});
		expect(done && compactParts(done).outcome).toBe("split the prompt, renderer, and lifecycle");
	});

	test("prefers the answer: so far while active, bare once done", () => {
		const withAnswer = JSON.stringify({ title: "Why flaky", answer: "a shared tmp dir", did: "read the logs" });
		const active = replayRecap(withAnswer, "active");
		const done = replayRecap(withAnswer, "done");
		expect(active && compactParts(active).outcome).toBe("so far: a shared tmp dir");
		expect(done && compactParts(done).outcome).toBe("a shared tmp dir");
	});

	test("blocked asks the user, else falls back to the active outcome", () => {
		const blocked = replayRecap(JSON.stringify({ title: "Plan", blocked: true, ask: "pick a layout", next: "draft" }), "done");
		const bare = replayRecap(JSON.stringify({ title: "Plan", blocked: true, next: "draft" }), "done");
		expect(blocked && compactParts(blocked).outcome).toBe("for you: pick a layout");
		expect(bare && compactParts(bare).outcome).toBe("next: draft");
	});

	test("leads with the first line of a reply without JSON", () => {
		const raw = replayRecap("\nPlain recap\nsecond line");
		expect(raw && compactParts(raw)).toEqual({ icon: undefined, title: "Plain recap" });
	});
});

describe("fitCompact", () => {
	const pieces = {
		icon: "⌛",
		title: "Implementing: Wire recap",
		request: "show where it stands",
		outcome: "next: rewrite prompt",
		meter: "━━━━━━━┄┄┄",
		elapsed: "20m",
		hint: "ctrl-h",
	};
	const left = "⌛ Implementing: Wire recap";
	const full = `${left} · show where it stands → next: rewrite prompt`;

	test("keeps everything when it fits, padding the right side to the edge", () => {
		const row = fitCompact(pieces, 100);
		expect(row.startsWith(full)).toBe(true);
		expect(row.endsWith("━━━━━━━┄┄┄ 20m ctrl-h")).toBe(true);
		expect(visibleWidth(row)).toBe(100);
	});

	test("drops the hint, then the request, then the meter", () => {
		const fullWidth = visibleWidth(full) + 2 + visibleWidth("━━━━━━━┄┄┄ 20m ctrl-h");
		expect(fitCompact(pieces, fullWidth - 1)).toMatch(/· show where it stands → next: rewrite prompt +━━━━━━━┄┄┄ 20m$/);
		const noRequest = fitCompact(pieces, fullWidth - 8);
		expect(noRequest).toStartWith(`${left} · next: rewrite prompt`);
		expect(noRequest).toEndWith("━━━━━━━┄┄┄ 20m");
		expect(fitCompact(pieces, visibleWidth(`${left} · next: rewrite prompt`) + 5)).toEndWith("prompt  20m");
	});

	test("drops fields whole rather than cutting them", () => {
		const row = fitCompact(pieces, visibleWidth(left) + 8);
		expect(row).toMatch(/^⌛ Implementing: Wire recap +20m$/);
	});

	test("shortens the title last, keeping the icon", () => {
		const row = fitCompact(pieces, 12);
		expect(row).toStartWith("⌛ ");
		expect(row).toEndWith("…");
		expect(visibleWidth(row)).toBeLessThanOrEqual(12);
	});

	test("without a title, the request leads and joins the outcome with an arrow", () => {
		const row = fitCompact({ ...pieces, title: undefined, meter: undefined, hint: undefined }, 60);
		expect(row).toStartWith("⌛ show where it stands → next: rewrite prompt");
	});
});

import { describe, expect, test } from "bun:test";
import { parseRecap, renderRecap, replayRecap } from "./recap.ts";

describe("parseRecap", () => {
	test("reads a plain JSON reply", () => {
		expect(parseRecap('{"title": "Fix flaky tests"}')).toEqual({ title: "Fix flaky tests" });
	});

	test("reads a fenced JSON reply", () => {
		const reply = '```json\n{"blocked": true, "title": "Fix flaky tests"}\n```';
		expect(parseRecap(reply)).toEqual({ blocked: true, title: "Fix flaky tests" });
	});

	test("reads JSON wrapped in prose", () => {
		const reply = 'Here you go:\n{"answer": "cache is cold"}\nHope that helps!';
		expect(parseRecap(reply)).toEqual({ answer: "cache is cold" });
	});

	test("returns undefined without a JSON object", () => {
		expect(parseRecap("nothing structured here")).toBeUndefined();
		expect(parseRecap("[1, 2, 3]")).toBeUndefined();
	});
});

describe("replayRecap", () => {
	test("parses a structured reply into a header and body", () => {
		const replay = replayRecap('{"kind": "debug", "title": "Fix flaky tests", "did": "pinned the clock"}', "done");
		expect(replay?.title).toBe("Debugged: Fix flaky tests");
		expect(replay?.icon).toBe("🟢");
		expect(replay?.markdown).toBe("- I did: pinned the clock");
	});

	test("keeps a title-only recap", () => {
		const replay = replayRecap('{"title": "Only a title", "goal": "   ", "did": ""}');
		expect(replay?.title).toBe("Only a title");
		expect(replay?.markdown).toBe("");
	});

	test("falls back to the raw reply when parsing fails", () => {
		const replay = replayRecap("no structure, just prose");
		expect(replay).toEqual({ markdown: "no structure, just prose" });
	});

	test("drops an empty reply", () => {
		expect(replayRecap("   ")).toBeUndefined();
	});
});

describe("renderRecap", () => {
	const recap = {
		blocked: true,
		kind: "implement",
		title: "Make clipcap emit structured recaps",
		goal: "structured recap output",
		progress: 40,
		answer: "dedupeReply can mangle JSON",
		did: "designed the JSON schema",
		ask: "pick schema field names",
		note: ["one", "two", "three"],
		next: ["rewrite RECAP_PROMPT", "add renderer"],
		refs: [{ title: "clipcap.ts", url: "https://example.com/clipcap.ts" }],
	};

	test("renders today's panel shape with the outcome ahead of everything", () => {
		const markdown = renderRecap(recap);
		const at = (text: string) => markdown.indexOf(text);
		expect(replayRecap(JSON.stringify(recap))?.title).toBe("Implementing: Make clipcap emit structured recaps");
		expect(at("- Goal: structured recap output")).toBeGreaterThan(-1);
		// The outcome is more important than did for questions and investigations.
		expect(at("- So far: dedupeReply can mangle JSON")).toBeGreaterThan(at("- Goal: structured recap output"));
		expect(at("- For you: pick schema field names")).toBeGreaterThan(at("- So far: dedupeReply can mangle JSON"));
	});

	test("hides I did whenever Result is present", () => {
		const withResult = renderRecap({ title: "T", answer: "PR is green", did: "bumped deps" });
		expect(withResult).toContain("- Result: PR is green");
		expect(withResult).not.toContain("I did");
		const withoutResult = renderRecap({ title: "T", did: "bumped deps" });
		expect(withoutResult).toContain("- I did: bumped deps");
	});

	test("caps notes and flows refs as links", () => {
		const markdown = renderRecap(recap, true);
		expect(markdown).toContain("- one\n- two\n- [clipcap.ts](https://example.com/clipcap.ts)");
		expect(markdown).toContain("- So far: dedupeReply can mangle JSON");
		expect(markdown).not.toContain("- three");
	});

	test("renders working-on items", () => {
		const markdown = renderRecap(recap, true);
		expect(markdown).toContain("**Working on:**\n- rewrite RECAP_PROMPT\n- add renderer");
	});

	test("keeps notes out of the compact view", () => {
		const compact = renderRecap(recap);
		expect(compact).not.toContain("- one");
		expect(compact).not.toContain("- two");
		expect(renderRecap(recap, true)).toContain("- one");
	});

	test("keeps the kind in progress unless the assumption is done", () => {
		const done = replayRecap('{"title": "T", "kind": "research"}', "done");
		const active = replayRecap('{"title": "T", "kind": "research"}', "active");
		const blocked = replayRecap('{"title": "T", "kind": "research", "blocked": true}', "done");
		expect([done?.title, done?.icon, done?.status]).toEqual(["Researched: T", "🟢", "done"]);
		expect([active?.title, active?.icon, active?.status]).toEqual(["Researching: T", "⌛", "active"]);
		expect([blocked?.title, blocked?.icon, blocked?.status]).toEqual(["Researching: T", "🖐️", "blocked"]);
	});

	test("renders a bare-string note as one line", () => {
		const markdown = renderRecap({ title: "T", note: "only line" }, true);
		expect(markdown).toContain("- only line");
	});

	test("drops incomplete refs", () => {
		const markdown = renderRecap({ title: "T", refs: [{ title: "no url", url: "" }] });
		expect(markdown).not.toContain("[no url]");
	});

	test.each(["notes.md", "ftp://example.com", "https://"])("drops non-http ref %s", url => {
		const markdown = renderRecap({ title: "T", refs: [{ title: "T", url }] });
		expect(markdown).not.toContain("[T]");
	});

	test("keeps absolute http(s) refs", () => {
		const markdown = renderRecap({ title: "T", refs: [{ title: "T", url: "https://example.com" }] });
		expect(markdown).toContain("[T](https://example.com)");
	});

	test("does not advertise refs when none are http(s)", () => {
		const replay = replayRecap('{"title": "T", "refs": [{"title": "T", "url": "notes.md"}]}');
		expect(replay?.extras).toEqual([]);
	});

	test("keeps free text out of link and emphasis markup", () => {
		const markdown = renderRecap({ title: "T", did: "selected [x] *now*" });
		expect(markdown).toContain("- I did: selected x now");
	});

	test("reports progress only while work is in flight", () => {
		expect(replayRecap('{"title": "T", "progress": 40}', "active")?.progress).toBe(40);
		expect(replayRecap('{"title": "T", "progress": 40, "blocked": true}', "done")?.progress).toBe(40);
		expect(replayRecap('{"title": "T", "progress": 100}', "active")?.progress).toBeUndefined();
		expect(replayRecap('{"title": "T", "progress": 0}', "active")?.progress).toBeUndefined();
		expect(replayRecap('{"title": "T", "progress": 40}', "done")?.progress).toBeUndefined();
	});
});

describe("details view", () => {
	const reply = '{"title": "T", "answer": "PR is green", "did": "bumped deps", "note": ["one"]}';

	test("details reveal the activity fields", () => {
		const replay = replayRecap(reply, "done");
		expect(replay?.markdown).toBe("- Result: PR is green");
		expect(replay?.extras).toEqual(["note"]);
		expect(replay?.expanded).toBe("- Result: PR is green\n- I did: bumped deps\n- one");
	});

	test("extras are the detail fields compact did not show", () => {
		const replay = replayRecap('{"title": "T", "note": ["one"]}');
		expect(replay?.extras).toEqual(["note"]);
	});

	test("never renders an empty activity line, even expanded", () => {
		const replay = replayRecap('{"title": "T", "answer": "yes", "did": ""}');
		expect(replay?.markdown).toBe("- Result: yes");
		expect(replay?.expanded).toBe("- Result: yes");
		expect(replay?.extras).toEqual([]);
	});

	test("compact mode carries the first ref inline", () => {
		const replay = replayRecap(
			'{"title": "T", "answer": "yes", "refs": [{"title": "PR", "url": "https://x/pr"}, {"title": "Extra", "url": "https://x/e"}]}',
			"done",
		);
		expect(replay?.markdown).toBe("- Result: yes\n- [PR](https://x/pr)");
		expect(replay?.markdown).not.toContain("So far");
	});

	test("hides For you while work is active, unless blocked", () => {
		const active = replayRecap('{"title": "T", "ask": "hold on"}', "active");
		expect(active?.markdown).toBe("");
		// The ask is hidden in compact; the details view stays reachable without one.
		expect(active?.extras).toEqual([]);
		expect(active?.expanded).toBe("");
		const blocked = replayRecap('{"title": "T", "blocked": true, "ask": "approve the plan"}', "active");
		expect(blocked?.markdown).toBe("- For you: approve the plan");
	});
});

describe("assumed status labels", () => {
	test("calls the outcome So far while work runs", () => {
		const active = replayRecap('{"title": "T", "answer": "reading the logs"}', "active");
		expect(active?.markdown).toBe("- So far: reading the logs");
	});

	test("keeps Result once the work stops", () => {
		const done = replayRecap('{"title": "T", "answer": "all green"}', "done");
		expect(done?.markdown).toBe("- Result: all green");
	});

	test("reads a blocked outcome as So far, hand up", () => {
		const blocked = replayRecap('{"title": "T", "blocked": true, "answer": "waiting on you"}');
		expect(blocked?.markdown).toBe("- So far: waiting on you");
	});
});

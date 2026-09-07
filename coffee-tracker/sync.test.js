/* Tests for the sync merge rules and the push/pull engine.
 *
 *   node --test coffee-tracker/
 */
const test = require("node:test");
const assert = require("node:assert");
const { rowsToDays, mergeDays, daysToPush, cleanDay, cleanPrefs, Engine } = require("./sync.js");

const cup = (id, at, mg) => ({ id, drink: "filter", name: "Filter", ml: 240, at, mg });

/* ------------------------------------------------------------ shaping ---- */

test("rowsToDays keeps well-formed rows and drops the rest", () => {
  const days = rowsToDays([
    { day: "2026-09-06", cups: [cup("a", "08:00", 95)] },
    { day: "not-a-date", cups: [cup("b", "09:00", 95)] },
    { day: "2026-09-07", cups: "not an array" },
  ]);
  assert.deepStrictEqual(Object.keys(days).sort(), ["2026-09-06", "2026-09-07"]);
  assert.strictEqual(days["2026-09-06"].length, 1);
  assert.deepStrictEqual(days["2026-09-07"], []);
});

test("cleanDay drops malformed cups and sorts by time", () => {
  const cups = cleanDay([
    cup("late", "15:00", 63),
    { id: "no-time", mg: 95 },
    { id: "bad-mg", at: "07:00", mg: -5 },
    { id: "huge-mg", at: "07:00", mg: 99999 },
    cup("early", "07:30", 95),
  ], "2026-09-07");
  assert.deepStrictEqual(cups.map((c) => c.id), ["early", "late"]);
});

test("cleanDay caps a day at 50 cups", () => {
  const many = Array.from({ length: 80 }, (_, i) => cup("c" + i, "08:00", 60));
  assert.strictEqual(cleanDay(many, "2026-09-07").length, 50);
});

/* ------------------------------------------------------------- merging --- */

test("merge unions cups from both sides", () => {
  const local = { "2026-09-07": [cup("a", "08:00", 95)] };
  const remote = { "2026-09-07": [cup("b", "14:00", 63)] };
  const { days } = mergeDays(local, remote);
  assert.deepStrictEqual(days["2026-09-07"].map((c) => c.id), ["a", "b"]);
});

test("merge keeps a shared cup exactly once", () => {
  const shared = cup("same", "08:00", 95);
  const { days } = mergeDays({ d: [shared] }, { d: [shared] });
  const merged = mergeDays({ "2026-09-07": [shared] }, { "2026-09-07": [shared] });
  assert.strictEqual(merged.days["2026-09-07"].length, 1);
  assert.ok(days);
});

test("merge is order-independent", () => {
  const a = { "2026-09-07": [cup("a", "08:00", 95)], "2026-09-06": [cup("c", "09:00", 63)] };
  const b = { "2026-09-07": [cup("b", "14:00", 63)] };
  const ab = mergeDays(a, b).days;
  const ba = mergeDays(b, a).days;
  assert.deepStrictEqual(ab, ba);
});

test("merge reports which days gained cups", () => {
  const local = { "2026-09-07": [cup("a", "08:00", 95)], "2026-09-05": [cup("x", "08:00", 95)] };
  const remote = { "2026-09-07": [cup("b", "14:00", 63)] };
  const { changed } = mergeDays(local, remote);
  assert.deepStrictEqual(changed, ["2026-09-07"]);
});

test("merge never loses a local-only day", () => {
  const local = { "2026-09-01": [cup("only", "08:00", 95)] };
  const { days } = mergeDays(local, {});
  assert.strictEqual(days["2026-09-01"].length, 1);
});

test("daysToPush finds days the server is missing or short on", () => {
  const merged = {
    "2026-09-07": [cup("a", "08:00", 95), cup("b", "14:00", 63)],
    "2026-09-06": [cup("c", "08:00", 95)],
  };
  const remote = { "2026-09-06": [cup("c", "08:00", 95)] };
  assert.deepStrictEqual(daysToPush(merged, remote), ["2026-09-07"]);
});

/* --------------------------------------------------------------- prefs --- */

test("cleanPrefs accepts server rows and rejects nonsense", () => {
  const fallback = { limitMg: 400, bedtime: "23:00" };
  assert.deepStrictEqual(cleanPrefs({ limit_mg: 300, bedtime: "22:15" }, fallback),
    { limitMg: 300, bedtime: "22:15" });
  assert.deepStrictEqual(cleanPrefs({ limit_mg: 99999, bedtime: "nope" }, fallback), fallback);
  assert.deepStrictEqual(cleanPrefs(null, fallback), fallback);
});

/* -------------------------------------------------------------- engine --- */

function harness(remote = { days: [], prefs: null }) {
  const state = {
    local: { days: {}, prefs: { limitMg: 400, bedtime: "23:00" } },
    pushedDays: [],
    pushedPrefs: [],
    statuses: [],
    failNext: null,
  };
  const adapter = {
    pull: async () => remote,
    pushDays: async (rows) => {
      if (state.failNext) { const e = state.failNext; state.failNext = null; throw e; }
      state.pushedDays.push(rows);
    },
    pushPrefs: async (prefs) => { state.pushedPrefs.push(prefs); },
  };
  const hooks = {
    getLocal: () => state.local,
    applyMerged: (days, prefs) => { state.local = { days, prefs }; },
    onStatus: (s) => state.statuses.push(s),
  };
  // debounce off: flush on the same tick so tests stay deterministic
  const engine = new Engine(adapter, hooks, { setTimeout: null, clearTimeout: null });
  return { engine, state };
}

test("start merges the server's ledger into the local one", async () => {
  const { engine, state } = harness({
    days: [{ day: "2026-09-06", cups: [cup("remote", "08:00", 95)] }],
    prefs: { limit_mg: 350, bedtime: "22:30" },
  });
  state.local.days["2026-09-07"] = [cup("local", "09:00", 63)];

  await engine.start();

  assert.deepStrictEqual(Object.keys(state.local.days).sort(), ["2026-09-06", "2026-09-07"]);
  assert.deepStrictEqual(state.local.prefs, { limitMg: 350, bedtime: "22:30" });
});

test("start pushes back the days the server was missing", async () => {
  const { engine, state } = harness({ days: [], prefs: { limit_mg: 400, bedtime: "23:00" } });
  state.local.days["2026-09-07"] = [cup("local", "09:00", 63)];

  await engine.start();

  assert.strictEqual(state.pushedDays.length, 1);
  assert.deepStrictEqual(state.pushedDays[0].map((r) => r.day), ["2026-09-07"]);
});

test("start with nothing new either side pushes nothing", async () => {
  const { engine, state } = harness({
    days: [{ day: "2026-09-07", cups: [cup("a", "08:00", 95)] }],
    prefs: { limit_mg: 400, bedtime: "23:00" },
  });
  state.local.days["2026-09-07"] = [cup("a", "08:00", 95)];

  await engine.start();

  assert.strictEqual(state.pushedDays.length, 0);
  assert.strictEqual(state.statuses[state.statuses.length - 1], "synced");
});

test("start seeds prefs when the server has none", async () => {
  const { engine, state } = harness({ days: [], prefs: null });
  await engine.start();
  assert.deepStrictEqual(state.pushedPrefs, [{ limitMg: 400, bedtime: "23:00" }]);
});

test("a failed push is retried, not dropped", async () => {
  const { engine, state } = harness();
  state.local.days["2026-09-07"] = [cup("a", "08:00", 95)];

  state.failNext = new Error("offline");
  engine.markDay("2026-09-07");
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(state.pushedDays.length, 0, "first attempt failed");
  assert.strictEqual(state.statuses[state.statuses.length - 1], "error");

  await engine.flush();
  assert.strictEqual(state.pushedDays.length, 1, "the day was retried");
  assert.strictEqual(state.statuses[state.statuses.length - 1], "synced");
});

test("markDay ignores a malformed key", async () => {
  const { engine, state } = harness();
  engine.markDay("garbage");
  await engine.flush();
  assert.strictEqual(state.pushedDays.length, 0);
});

test("an edit made mid-flight is not lost", async () => {
  const { engine, state } = harness();
  state.local.days["2026-09-07"] = [cup("a", "08:00", 95)];

  engine.inFlight = true;
  engine.markDay("2026-09-07");
  assert.strictEqual(state.pushedDays.length, 0);

  engine.inFlight = false;
  engine.again = false;
  await engine.flush();
  assert.strictEqual(state.pushedDays.length, 1);
});

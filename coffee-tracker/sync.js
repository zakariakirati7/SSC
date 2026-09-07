/* Brew Ledger sync — merge rules and the push/pull loop.
 *
 * Kept apart from the page so it can be tested in node; the build script
 * inlines it into the published file. Nothing here touches the DOM or the
 * network: the engine talks to an adapter, which the page implements with
 * the Supabase client.
 *
 * The local ledger stays the source of truth. Sync mirrors it, so the app
 * works with the network down, the backend misconfigured, or nobody signed
 * in — those are ordinary states, not errors.
 */
(function (root) {
  "use strict";

  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_RE = /^\d{1,2}:\d{2}$/;

  function minutesOf(hhmm) {
    var p = String(hhmm || "00:00").split(":");
    return (+p[0]) * 60 + (+p[1] || 0);
  }

  /* One cup, sanitised. Returns null for anything malformed — a bad row from
   * the server is dropped rather than allowed to corrupt the local ledger. */
  function cleanCup(raw, dayKey, index) {
    if (!raw || typeof raw !== "object") return null;
    var mg = Number(raw.mg);
    if (!isFinite(mg) || mg < 0 || mg > 2000) return null;
    if (typeof raw.at !== "string" || !TIME_RE.test(raw.at)) return null;
    var ml = Number(raw.ml);
    return {
      id: String(raw.id || (dayKey + "-" + raw.at + "-" + mg + "-" + index)).slice(0, 64),
      drink: String(raw.drink || "filter").slice(0, 40),
      name: String(raw.name || "Coffee").slice(0, 60),
      ml: isFinite(ml) && ml >= 0 ? Math.round(ml) : 0,
      at: raw.at,
      mg: Math.round(mg)
    };
  }

  function cleanDay(cups, dayKey) {
    if (!Array.isArray(cups)) return [];
    var out = [];
    for (var i = 0; i < cups.length && out.length < 50; i++) {
      var cup = cleanCup(cups[i], dayKey, i);
      if (cup) out.push(cup);
    }
    out.sort(function (a, b) { return minutesOf(a.at) - minutesOf(b.at); });
    return out;
  }

  /* Rows as the server returns them -> the page's {date: [cup, ...]} shape. */
  function rowsToDays(rows) {
    var days = {};
    (rows || []).forEach(function (row) {
      var key = String(row && row.day || "").slice(0, 10);
      if (!DAY_RE.test(key)) return;
      days[key] = cleanDay(row.cups, key);
    });
    return days;
  }

  /* Union by cup id, per day.
   *
   * Union rather than last-writer-wins: two devices that each logged a
   * different cup should end with both, which a whole-day overwrite would
   * not give. Cup ids are unique per logging event, so a cup present on both
   * sides is the same cup and is kept once. The result is order-independent
   * — merging A into B gives what merging B into A gives.
   *
   * Returns the merged days plus the keys that differ from `local`, which
   * are exactly the days worth pushing back. */
  function mergeDays(local, remote) {
    var merged = {};
    var changed = [];
    var keys = {};

    Object.keys(local || {}).forEach(function (k) { keys[k] = true; });
    Object.keys(remote || {}).forEach(function (k) { keys[k] = true; });

    Object.keys(keys).forEach(function (key) {
      if (!DAY_RE.test(key)) return;

      var mine = cleanDay((local || {})[key], key);
      var theirs = cleanDay((remote || {})[key], key);

      var seen = {};
      var union = [];
      mine.concat(theirs).forEach(function (cup) {
        if (seen[cup.id]) return;
        seen[cup.id] = true;
        union.push(cup);
      });
      union.sort(function (a, b) { return minutesOf(a.at) - minutesOf(b.at); });

      merged[key] = union;
      if (union.length !== mine.length) changed.push(key);
    });

    return { days: merged, changed: changed };
  }

  /* Which days does the server not yet have, or hold a shorter version of? */
  function daysToPush(merged, remote) {
    var out = [];
    Object.keys(merged || {}).forEach(function (key) {
      var theirs = ((remote || {})[key] || []).length;
      var ours = (merged[key] || []).length;
      if (ours !== theirs) out.push(key);
    });
    return out;
  }

  function cleanPrefs(raw, fallback) {
    var prefs = { limitMg: fallback.limitMg, bedtime: fallback.bedtime };
    if (!raw || typeof raw !== "object") return prefs;
    var lim = parseInt(raw.limitMg !== undefined ? raw.limitMg : raw.limit_mg, 10);
    if (isFinite(lim) && lim >= 50 && lim <= 2000) prefs.limitMg = lim;
    var bed = raw.bedtime;
    if (typeof bed === "string" && TIME_RE.test(bed)) prefs.bedtime = bed;
    return prefs;
  }

  /* ------------------------------------------------------------------ *
   * The engine.
   *
   * adapter: { pull(), pushDays(rows), pushPrefs(prefs) } returning promises
   * hooks:   { getLocal(), applyMerged(days, prefs), onStatus(state, detail) }
   * ------------------------------------------------------------------ */
  function Engine(adapter, hooks, options) {
    var opts = options || {};
    this.adapter = adapter;
    this.hooks = hooks;
    this.debounceMs = opts.debounceMs === undefined ? 1500 : opts.debounceMs;
    // `in` rather than `||`, so passing null explicitly disables the debounce
    // (flush on the spot) instead of silently falling back to real timers.
    this.setTimeout = "setTimeout" in opts
      ? opts.setTimeout
      : (typeof setTimeout === "function" ? setTimeout : null);
    this.clearTimeout = "clearTimeout" in opts
      ? opts.clearTimeout
      : (typeof clearTimeout === "function" ? clearTimeout : null);

    this.dirtyDays = {};
    this.prefsDirty = false;
    this.timer = null;
    this.inFlight = false;
    this.again = false;
    this.remoteSeen = {};
  }

  Engine.prototype.status = function (state, detail) {
    if (this.hooks.onStatus) this.hooks.onStatus(state, detail);
  };

  /* First sync after sign-in: take what the server has, union it with what
   * this device has, and push back anything the server was missing. */
  Engine.prototype.start = function () {
    var self = this;
    this.status("syncing");

    return this.adapter.pull().then(function (remote) {
      var local = self.hooks.getLocal();
      var remoteDays = rowsToDays(remote && remote.days);
      self.remoteSeen = remoteDays;

      var merged = mergeDays(local.days, remoteDays);
      var prefs = remote && remote.prefs
        ? cleanPrefs(remote.prefs, local.prefs)
        : local.prefs;

      self.hooks.applyMerged(merged.days, prefs);

      var pending = daysToPush(merged.days, remoteDays);
      if (!pending.length && remote && remote.prefs) {
        self.status("synced");
        return { pushed: 0 };
      }

      pending.forEach(function (key) { self.dirtyDays[key] = true; });
      if (!remote || !remote.prefs) self.prefsDirty = true;
      return self.flush().then(function () { return { pushed: pending.length }; });
    }).catch(function (err) {
      self.status("error", err);
      throw err;
    });
  };

  Engine.prototype.markDay = function (key) {
    if (!DAY_RE.test(key)) return;
    this.dirtyDays[key] = true;
    this.schedule();
  };

  Engine.prototype.markPrefs = function () {
    this.prefsDirty = true;
    this.schedule();
  };

  /* Batch rapid edits — logging three cups in a row is one round trip. */
  Engine.prototype.schedule = function () {
    var self = this;
    if (!this.setTimeout) return this.flush();
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = this.setTimeout(function () {
      self.timer = null;
      self.flush();
    }, this.debounceMs);
  };

  Engine.prototype.flush = function () {
    var self = this;

    // One request at a time; a change made mid-flight queues another pass
    // rather than racing it.
    if (this.inFlight) {
      this.again = true;
      return Promise.resolve();
    }

    var keys = Object.keys(this.dirtyDays);
    var pushPrefs = this.prefsDirty;
    if (!keys.length && !pushPrefs) return Promise.resolve();

    this.dirtyDays = {};
    this.prefsDirty = false;
    this.inFlight = true;
    this.status("syncing");

    var local = this.hooks.getLocal();
    var rows = keys.map(function (key) {
      return { day: key, cups: cleanDay(local.days[key], key) };
    });

    var work = [];
    if (rows.length) work.push(this.adapter.pushDays(rows));
    if (pushPrefs) work.push(this.adapter.pushPrefs(local.prefs));

    return Promise.all(work).then(function () {
      self.inFlight = false;
      rows.forEach(function (row) { self.remoteSeen[row.day] = row.cups; });
      if (self.again) {
        self.again = false;
        return self.flush();
      }
      self.status("synced");
    }).catch(function (err) {
      self.inFlight = false;
      // Put the work back so the next attempt retries it.
      keys.forEach(function (key) { self.dirtyDays[key] = true; });
      if (pushPrefs) self.prefsDirty = true;
      self.status("error", err);
    });
  };

  Engine.prototype.stop = function () {
    if (this.timer && this.clearTimeout) this.clearTimeout(this.timer);
    this.timer = null;
    this.dirtyDays = {};
    this.prefsDirty = false;
  };

  var api = {
    rowsToDays: rowsToDays,
    mergeDays: mergeDays,
    daysToPush: daysToPush,
    cleanDay: cleanDay,
    cleanPrefs: cleanPrefs,
    Engine: Engine
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.BrewSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

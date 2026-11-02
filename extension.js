import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {compatibilityIssues} from './compat.js';

// Quiet period before a layout snapshot is taken. Mutter's own hotplug
// shuffling keeps resetting this timer, so a snapshot never captures it.
const SAVE_DELAY_MS = 1000;
// Wait after the last monitors-changed before restoring, so Mutter has
// finished relocating windows.
const RESTORE_DELAY_MS = 1500;
// Wayland clients resize asynchronously; a second pass fixes up windows
// that ignored or raced the first one.
const SECOND_PASS_DELAY_MS = 600;
// No snapshots for at least this long after a restore: plugging in a dock
// often produces further monitors-changed a few seconds after the first, and
// a snapshot in between would overwrite the good layout with the
// intermediate config. Grows with the measured settle time (see _settleMs).
const MIN_SETTLE_MS = 5000;
const MAX_AUTO_SETTLE_MS = 20000;
const SETTLE_MARGIN_MS = 2000;
const SETTLE_SAMPLES = 5;
// Same monitors but a different primary than when the setup was saved is
// usually a dock's intermediate config. If it persists this long, accept it
// as the user's choice.
const PRIMARY_MISMATCH_FALLBACK_MS = 8000;

// A closed window stays in the saved state this long. At logout apps close
// one by one before the shell exits; without this the state file would end
// up empty.
const CLOSE_RETENTION_MS = 15000;
// After login, windows opening within this period are matched against the
// last session.
const PLACEMENT_WINDOW_MS = 120000;
// Browsers show a generic title first; keep re-matching on title changes
// for this long after a window appears.
const TITLE_WATCH_MS = 8000;
// When a matched window is placed; later passes catch slow clients.
const MATCH_PASSES_MS = [0, 1000, 4000];
const LAUNCH_STAGGER_MS = 500;
// Size of a window moved to an external monitor with no saved position there.
const EXTERNAL_SIZE_RATIO = 0.6;
// Let the session settle before showing compatibility warnings.
const COMPAT_NOTIFY_DELAY_MS = 5000;

const STATE_VERSION = 2;
const STATE_FILE = GLib.build_filenamev([GLib.get_user_state_dir(), 'dynamic-window-position', 'session.json']);

let debugEnabled = false;

function debug(msg) {
    if (debugEnabled)
        console.log(`[dynamic-window-position] ${msg}`);
}

function shellPid() {
    return Gio.Credentials.new().get_unix_pid();
}

// Stable identity of a physical monitor: the same monitor gets the same id
// whatever connector, position or index it has.
function monitorId(monitor) {
    if (monitor.is_builtin())
        return 'builtin';
    const serial = monitor.get_serial();
    const unique = serial && !/^(0x)?0*$/i.test(serial) ? serial : monitor.get_connector();
    return [monitor.get_vendor(), monitor.get_product(), unique].join(':');
}

// Moves and shrinks rect so it lies entirely within area.
function fitInto(area, rect) {
    const width = Math.min(rect.width, area.width);
    const height = Math.min(rect.height, area.height);
    return {
        x: Math.min(Math.max(rect.x, area.x), area.x + area.width - width),
        y: Math.min(Math.max(rect.y, area.y), area.y + area.height - height),
        width,
        height,
    };
}

// Jaccard similarity of the words in two titles, 0..1.
function titleSimilarity(a, b) {
    const words = s => new Set((s ?? '').toLowerCase().split(/[\s\-—–|·:•]+/).filter(Boolean));
    const wa = words(a), wb = words(b);
    if (!wa.size || !wb.size)
        return 0;
    let common = 0;
    for (const w of wa) {
        if (wb.has(w))
            common++;
    }
    return common / (wa.size + wb.size - common);
}

export default class DynamicWindowPositionExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        debugEnabled = this._settings.get_boolean('debug-logging');
        this._settings.connectObject(
            'changed::debug-logging', () => {
                debugEnabled = this._settings.get_boolean('debug-logging');
            },
            this);

        // Setups are keyed by the set of connected monitors (see
        // _monitorInfo); window positions are relative to their monitor.
        this._layouts = new Map(); // setup key -> { primary, activeWorkspace, windows: Map<uid, entry> }
        this._identities = new Map(); // uid -> { app, wmClass, title, seq }
        this._uids = new Map(); // stable sequence -> uid
        this._fromSession = new Set(); // uids loaded from the state file
        this._pending = new Set(); // last-session uids not matched to a window yet
        this._exact = new Set(); // windows matched by exact title; no re-matching
        this._closing = new Map(); // uid -> retention timeout id
        // Where each app's last closed window was, per setup (see
        // remember-app-positions): app key -> Map<setup key, entry>.
        this._appPositions = new Map();
        this._tracked = new Set(); // Meta.Window
        this._pendingShown = new Map(); // Meta.Window -> 'shown' handler id
        this._titleWatches = new Map(); // Meta.Window -> 'notify::title' handler id
        this._timeouts = new Set();
        this._placementUntil = 0;
        this._restoring = false;
        this._burstStart = this._burstEnd = 0;
        this._saveId = this._restoreId = this._secondPassId = this._graceId = 0;
        this._currentKey = this._monitorInfo().key;

        global.display.connectObject(
            'window-created', (_display, win) => this._onWindowCreated(win),
            this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._onMonitorsChanged(),
            this);

        const existing = global.get_window_actors().map(actor => actor.meta_window);
        for (const win of existing)
            this._trackWindow(win);

        const freshLogin = this._loadState(existing);
        if (freshLogin && this._settings.get_boolean('restore-session'))
            this._startSessionRestore(existing);
        else if (freshLogin)
            this._endPlacementWindow();

        this._save();
        this._timeout(COMPAT_NOTIFY_DELAY_MS, () => this._notifyCompatibility());
        debug(`enabled, setup=${this._currentKey}, fresh login=${freshLogin}`);
    }

    disable() {
        this._settings.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);

        for (const win of this._tracked)
            win.disconnectObject(this);
        for (const [win, id] of this._pendingShown)
            win.disconnect(id);
        for (const [win, id] of this._titleWatches)
            win.disconnect(id);

        this._cancelTimers();
        for (const id of this._timeouts)
            GLib.Source.remove(id);

        this._settings = null;
        this._layouts = null;
        this._identities = null;
        this._uids = null;
        this._fromSession = null;
        this._pending = null;
        this._exact = null;
        this._closing = null;
        this._appPositions = null;
        this._tracked = null;
        this._pendingShown = null;
        this._titleWatches = null;
        this._timeouts = null;
        this._restoring = false;
    }

    _cancelTimers() {
        for (const id of [this._saveId, this._restoreId, this._secondPassId, this._graceId]) {
            if (id)
                GLib.Source.remove(id);
        }
        this._saveId = this._restoreId = this._secondPassId = this._graceId = 0;
    }

    _timeout(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    // key: the connected monitors, e.g. "SAM:U32J59x:H4ZMC00130 + builtin";
    // primary: id of the primary monitor; ids: monitor index -> id.
    _monitorInfo() {
        const ids = new Map();
        const all = [];
        for (const logical of global.backend.get_monitor_manager().get_logical_monitors()) {
            const monitors = logical.get_monitors();
            ids.set(logical.get_number(), monitorId(monitors[0]));
            for (const monitor of monitors)
                all.push(monitorId(monitor));
        }
        all.sort();
        return {
            key: all.join(' + '),
            primary: ids.get(global.display.get_primary_monitor()) ?? null,
            ids,
            laptopOnly: all.length === 1 && all[0] === 'builtin',
        };
    }

    _monitorIndex(info, id) {
        for (const [index, monitor] of info.ids) {
            if (monitor === id)
                return index;
        }
        return undefined;
    }

    _isManageable(win) {
        return win.get_window_type() === Meta.WindowType.NORMAL &&
            !win.is_skip_taskbar() &&
            !win.get_transient_for() &&
            win.allows_move();
    }

    _windows() {
        return global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(win => this._isManageable(win));
    }

    _appId(win) {
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        return app && !app.is_window_backed() ? app.get_id() : null;
    }

    // Apps without a desktop file are told apart by their WM class.
    _appKey(win) {
        return this._appId(win) ?? `wm:${win.get_wm_class()}`;
    }

    _hasOtherWindow(win) {
        const key = this._appKey(win);
        return this._windows().some(other => other !== win && this._appKey(other) === key);
    }

    _uidFor(win) {
        const seq = win.get_stable_sequence();
        let uid = this._uids.get(seq);
        if (!uid) {
            uid = GLib.uuid_string_random();
            this._uids.set(seq, uid);
        }
        return uid;
    }

    _forget(uid) {
        for (const layout of this._layouts.values())
            layout.windows.delete(uid);
        this._identities.delete(uid);
        this._fromSession.delete(uid);
    }

    _trackWindow(win) {
        if (this._tracked.has(win))
            return;
        this._tracked.add(win);

        win.connectObject(
            'position-changed', () => this._queueSave(),
            'size-changed', () => this._queueSave(),
            'workspace-changed', () => this._queueSave(),
            'unmanaged', () => this._onUnmanaged(win),
            this);
    }

    _onWindowCreated(win) {
        this._trackWindow(win);

        // Wait for the first 'shown' so Mutter has placed the window and
        // the app is known.
        const id = win.connect('shown', () => {
            win.disconnect(id);
            this._pendingShown.delete(win);
            this._onWindowReady(win);
        });
        this._pendingShown.set(win, id);
    }

    _onWindowReady(win) {
        if (!this._isManageable(win))
            return;

        if (this._inPlacementWindow()) {
            this._watchTitle(win);
            if (this._matchWindow(win, false))
                return;
        }

        if (this._settings.get_boolean('remember-app-positions') && !this._restoring &&
            !this._hasOtherWindow(win))
            this._placeFromApp(win);
    }

    // Puts an app's first window where its last closed window was in this
    // setup, but on the current workspace.
    _placeFromApp(win) {
        const remembered = this._appPositions.get(this._appKey(win))?.get(this._currentKey);
        if (!remembered)
            return;
        debug(`"${win.get_title()}" opens where its app was last closed`);
        const entry = {...remembered, workspace: -1};
        const apply = () => {
            if (!this._restoring && this._tracked.has(win))
                this._applyEntry(win, entry, this._monitorInfo());
        };
        for (const ms of MATCH_PASSES_MS) {
            if (ms === 0)
                apply();
            else
                this._timeout(ms, apply);
        }
    }

    _onUnmanaged(win) {
        win.disconnectObject(this);
        this._tracked.delete(win);
        this._exact.delete(win);

        for (const handlers of [this._pendingShown, this._titleWatches]) {
            const id = handlers.get(win);
            if (id) {
                win.disconnect(id);
                handlers.delete(win);
            }
        }

        const seq = win.get_stable_sequence();
        const uid = this._uids.get(seq);
        this._uids.delete(seq);
        if (uid) {
            this._rememberAppPosition(win, uid);
            this._closing.set(uid, this._timeout(CLOSE_RETENTION_MS, () => {
                this._closing.delete(uid);
                this._forget(uid);
                this._persist();
            }));
        }
        this._queueSave();
    }

    _rememberAppPosition(win, uid) {
        const key = this._appKey(win);
        let positions = this._appPositions.get(key);
        for (const [setup, layout] of this._layouts) {
            const entry = layout.windows.get(uid);
            if (!entry)
                continue;
            if (!positions) {
                positions = new Map();
                this._appPositions.set(key, positions);
            }
            positions.set(setup, entry);
        }
    }

    _queueSave() {
        if (this._restoring)
            return;
        if (this._saveId)
            GLib.Source.remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _save() {
        if (this._restoring)
            return;
        // The monitors changed but the restore hasn't run yet: whatever is
        // on screen now is Mutter's shuffle, not a layout worth keeping.
        const info = this._monitorInfo();
        if (info.key !== this._currentKey)
            return;

        const previous = this._layouts.get(this._currentKey)?.windows;
        const windows = new Map();
        for (const win of this._windows()) {
            const uid = this._uidFor(win);
            const index = win.get_monitor();
            const monitor = global.display.get_monitor_geometry(index);
            const rect = win.get_frame_rect();
            windows.set(uid, {
                monitor: info.ids.get(index) ?? null,
                x: rect.x - monitor.x,
                y: rect.y - monitor.y,
                width: rect.width,
                height: rect.height,
                maximized: win.is_maximized(),
                workspace: win.get_workspace()?.index() ?? -1,
                onAllWorkspaces: win.is_on_all_workspaces(),
            });
            this._identities.set(uid, {
                app: this._appId(win),
                wmClass: win.get_wm_class(),
                title: win.get_title() ?? '',
                seq: win.get_stable_sequence(),
            });
        }
        // Keep windows still expected from the last session and recently
        // closed ones (see CLOSE_RETENTION_MS).
        for (const [uid, entry] of previous ?? []) {
            if (!windows.has(uid) && (this._pending.has(uid) || this._closing.has(uid)))
                windows.set(uid, entry);
        }

        this._layouts.set(this._currentKey, {
            primary: info.primary,
            activeWorkspace: global.workspace_manager.get_active_workspace_index(),
            windows,
        });
        this._persist();
    }

    // Session state on disk

    _persist() {
        const layouts = {};
        for (const [key, layout] of this._layouts) {
            layouts[key] = {
                primary: layout.primary,
                activeWorkspace: layout.activeWorkspace,
                windows: Object.fromEntries(layout.windows),
            };
        }
        const state = {
            version: STATE_VERSION,
            shellPid: shellPid(),
            savedAt: new Date().toISOString(),
            layouts,
            identities: Object.fromEntries(this._identities),
            appPositions: Object.fromEntries([...this._appPositions]
                .map(([app, positions]) => [app, Object.fromEntries(positions)])),
        };
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(STATE_FILE), 0o700);
            GLib.file_set_contents(STATE_FILE, JSON.stringify(state));
        } catch (e) {
            console.warn(`[dynamic-window-position] could not write ${STATE_FILE}: ${e.message}`);
        }
    }

    // Loads the state file. Returns true on a fresh login (state written by
    // a previous shell process), with its windows marked pending.
    _loadState(existing) {
        let state;
        try {
            const [, contents] = GLib.file_get_contents(STATE_FILE);
            state = JSON.parse(new TextDecoder().decode(contents));
        } catch {
            return false;
        }
        if (state?.version === 1)
            state = this._migrateV1(state);
        if (state?.version !== STATE_VERSION)
            return false;

        for (const [key, layout] of Object.entries(state.layouts ?? {})) {
            this._layouts.set(key, {
                primary: layout.primary ?? null,
                activeWorkspace: layout.activeWorkspace ?? 0,
                windows: new Map(Object.entries(layout.windows ?? {})),
            });
        }
        for (const [app, positions] of Object.entries(state.appPositions ?? {}))
            this._appPositions.set(app, new Map(Object.entries(positions)));
        for (const [uid, identity] of Object.entries(state.identities ?? {})) {
            this._identities.set(uid, identity);
            this._fromSession.add(uid);
        }

        if (state.shellPid === shellPid()) {
            // Re-enabled within the same session: these are the same
            // windows, so rebind by stable sequence and move nothing.
            const live = new Set(existing.map(win => win.get_stable_sequence()));
            for (const [uid, identity] of [...this._identities]) {
                if (live.has(identity.seq))
                    this._uids.set(identity.seq, uid);
                else
                    this._forget(uid);
            }
            return false;
        }

        for (const uid of this._identities.keys())
            this._pending.add(uid);
        return this._pending.size > 0;
    }

    // Version 1 kept one 'laptop' and one 'docked' layout with absolute
    // coordinates and monitor indices. The laptop screen alone is always at
    // 0,0; the docked layout can only be converted while docked, using the
    // current arrangement. Anything else is relearned.
    _migrateV1(state) {
        const info = this._monitorInfo();
        const convert = (old, idOf, originOf, primary) => {
            const windows = {};
            for (const [uid, entry] of Object.entries(old.windows ?? {})) {
                const id = idOf(entry.monitor);
                if (!id)
                    continue;
                const origin = originOf(entry.monitor);
                windows[uid] = {
                    monitor: id,
                    x: entry.rect.x - origin.x,
                    y: entry.rect.y - origin.y,
                    width: entry.rect.width,
                    height: entry.rect.height,
                    maximized: entry.maximized,
                    workspace: entry.workspace,
                    onAllWorkspaces: entry.onAllWorkspaces,
                };
            }
            return {primary, activeWorkspace: old.activeWorkspace ?? 0, windows};
        };

        const layouts = {};
        if (state.layouts?.laptop)
            layouts['builtin'] = convert(state.layouts.laptop, () => 'builtin', () => ({x: 0, y: 0}), 'builtin');
        if (state.layouts?.docked && info.ids.size > 1 && info.primary !== 'builtin') {
            layouts[info.key] = convert(state.layouts.docked,
                index => info.ids.get(index),
                index => global.display.get_monitor_geometry(index),
                info.primary);
        }
        debug(`migrated saved layouts to per-monitor setups: ${Object.keys(layouts).join(', ')}`);
        return {...state, version: STATE_VERSION, layouts};
    }

    // Session restore at login

    _startSessionRestore(existing) {
        debug(`restoring last session: ${this._pending.size} windows`);
        this._placementUntil = GLib.get_monotonic_time() + PLACEMENT_WINDOW_MS * 1000;

        for (const win of existing)
            this._onWindowReady(win);

        this._timeout(this._settings.get_int('launch-delay') * 1000,
            () => this._launchMissingApps());
        this._timeout(PLACEMENT_WINDOW_MS, () => this._endPlacementWindow());
    }

    _inPlacementWindow() {
        return this._pending.size > 0 && GLib.get_monotonic_time() < this._placementUntil;
    }

    _launchMissingApps() {
        const ignored = new Set(this._settings.get_strv('ignored-apps'));
        const appSystem = Shell.AppSystem.get_default();

        // Once per app: apps with several windows (browsers, editors,
        // Ptyxis) reopen the rest themselves.
        const ids = [];
        for (const uid of this._pending) {
            const id = this._identities.get(uid)?.app;
            if (id && !ids.includes(id) && !ignored.has(id))
                ids.push(id);
        }

        ids.forEach((id, i) => this._timeout(i * LAUNCH_STAGGER_MS, () => {
            const app = appSystem.lookup_app(id);
            if (!app || app.state !== Shell.AppState.STOPPED)
                return;
            debug(`launching ${id}`);
            try {
                app.launch(0, -1, Shell.AppLaunchGpu.APP_PREF);
            } catch (e) {
                console.warn(`[dynamic-window-position] could not launch ${id}: ${e.message}`);
            }
        }));
    }

    _endPlacementWindow() {
        if (this._pending.size) {
            const titles = [...this._pending].map(uid => `"${this._identities.get(uid)?.title}"`);
            debug(`session restore over; did not come back: ${titles.join(', ')}`);
        }
        for (const uid of this._pending)
            this._forget(uid);
        this._pending.clear();
        this._persist();
    }

    _watchTitle(win) {
        if (this._titleWatches.has(win))
            return;
        const id = win.connect('notify::title', () => {
            if (!this._exact.has(win) && this._inPlacementWindow())
                this._matchWindow(win, true);
        });
        this._titleWatches.set(win, id);
        this._timeout(TITLE_WATCH_MS, () => {
            if (this._titleWatches.get(win) === id) {
                win.disconnect(id);
                this._titleWatches.delete(win);
            }
        });
    }

    // Matches a window to a pending last-session window of the same app,
    // preferring the same title. With exactOnly, only an exact title match
    // counts (used to correct an earlier guess once the real title shows).
    _matchWindow(win, exactOnly) {
        const appId = this._appId(win);
        const wmClass = win.get_wm_class();
        const title = win.get_title() ?? '';

        let best = null;
        let bestScore = -1;
        for (const uid of this._pending) {
            const identity = this._identities.get(uid);
            const sameApp = identity?.app ? identity.app === appId : identity?.wmClass === wmClass;
            if (!sameApp)
                continue;
            const score = identity.title === title ? 100 : titleSimilarity(identity.title, title) * 50;
            if (score > bestScore) {
                best = uid;
                bestScore = score;
            }
        }
        if (!best || (exactOnly && bestScore < 100))
            return false;

        debug(`matched "${title}" to "${this._identities.get(best).title}" (score ${Math.round(bestScore)})`);
        this._bind(win, best);
        if (bestScore === 100)
            this._exact.add(win);
        this._placeMatched(win, best);
        return true;
    }

    _bind(win, uid) {
        const seq = win.get_stable_sequence();
        const old = this._uids.get(seq);
        if (old && old !== uid) {
            // An earlier guess goes back to the pool; a fresh uid is dropped.
            if (this._fromSession.has(old))
                this._pending.add(old);
            else
                this._forget(old);
        }
        this._uids.set(seq, uid);
        this._pending.delete(uid);
    }

    _placeMatched(win, uid) {
        const apply = () => {
            if (this._restoring || !this._tracked.has(win) ||
                this._uids.get(win.get_stable_sequence()) !== uid)
                return;

            const info = this._monitorInfo();
            const entry = this._layouts.get(this._currentKey)?.windows.get(uid);
            if (entry && this._applyEntry(win, entry, info))
                return;
            // Only saved in another setup: there was no monitor change, so
            // leave it where GNOME put it, on its workspace from there.
            for (const layout of this._layouts.values()) {
                const other = layout.windows.get(uid);
                if (other && !other.onAllWorkspaces && other.workspace >= 0) {
                    this._moveToWorkspace(win, other.workspace);
                    break;
                }
            }
        };

        for (const ms of MATCH_PASSES_MS) {
            if (ms === 0)
                apply();
            else
                this._timeout(ms, apply);
        }
    }

    // Monitor hotplug

    _onMonitorsChanged() {
        const info = this._monitorInfo();
        debug(`monitors changed: ${info.key} (primary ${info.primary})`);

        const now = GLib.get_monotonic_time() / 1000;
        if (!this._burstStart)
            this._burstStart = now;
        this._burstEnd = now;

        // Restarts the whole restore cycle, including an unfinished settle
        // period: nothing has been saved since the last settled setup, so
        // its layouts are still intact.
        this._restoring = true;
        this._cancelTimers();
        this._scheduleRestore(RESTORE_DELAY_MS, false);
    }

    // How long to keep snapshots off after a restore: the configured value,
    // or the longest recently measured monitor change plus a margin.
    _settleMs() {
        const configured = this._settings.get_int('settle-delay');
        if (configured > 0)
            return configured * 1000;
        const recent = this._settings.get_value('recent-settle-ms').deepUnpack();
        const longest = recent.length ? Math.max(...recent) : 0;
        return Math.min(Math.max(longest + SETTLE_MARGIN_MS, MIN_SETTLE_MS), MAX_AUTO_SETTLE_MS);
    }

    _recordSettle() {
        const duration = Math.round(this._burstEnd - this._burstStart);
        this._burstStart = this._burstEnd = 0;
        const recent = [...this._settings.get_value('recent-settle-ms').deepUnpack(), duration]
            .slice(-SETTLE_SAMPLES);
        this._settings.set_value('recent-settle-ms', new GLib.Variant('ai', recent));
        debug(`monitor change took ${duration} ms to settle; recent: ${recent.join(', ')}`);
    }

    _scheduleRestore(delay, isFallback) {
        this._restoreId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._restoreId = 0;
            this._restore(isFallback);
            return GLib.SOURCE_REMOVE;
        });
    }

    _restore(isFallback) {
        const info = this._monitorInfo();
        if (!info.ids.size) {
            this._scheduleRestore(RESTORE_DELAY_MS, isFallback);
            return;
        }

        const layout = this._layouts.get(info.key);
        if (!isFallback && layout?.primary && info.primary !== layout.primary) {
            debug(`primary is ${info.primary} but was ${layout.primary} in this setup: waiting`);
            this._scheduleRestore(Math.max(PRIMARY_MISMATCH_FALLBACK_MS, this._settleMs()), true);
            return;
        }

        const fromKey = this._currentKey;
        const key = info.key;
        const prevLayout = fromKey !== key ? this._layouts.get(fromKey) : null;
        debug(`restoring ${fromKey} -> ${key}${layout ? '' : ' (new setup)'}`);

        this._applyLayout(layout, prevLayout);
        this._secondPassId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SECOND_PASS_DELAY_MS, () => {
            this._secondPassId = 0;
            this._applyLayout(layout, prevLayout);
            this._graceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._settleMs(), () => {
                this._graceId = 0;
                // Final fix-up for slow clients whose earlier configure was
                // acked late and landed them on the active workspace.
                debug('final pass');
                this._applyLayout(layout, prevLayout);
                this._secondPassId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SECOND_PASS_DELAY_MS, () => {
                    this._secondPassId = 0;
                    this._settle(key);
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _settle(key) {
        debug(`settled on ${key}`);
        this._recordSettle();
        this._currentKey = key;
        this._restoring = false;
        this._save();
    }

    _applyLayout(layout, prevLayout) {
        const info = this._monitorInfo();
        for (const win of this._windows()) {
            const uid = this._uids.get(win.get_stable_sequence());
            const entry = uid && layout?.windows.get(uid);
            if (entry && this._applyEntry(win, entry, info))
                continue;

            // Not seen in this setup before: keep the workspace it had in the
            // setup we're coming from, and use the app's last position here
            // or else the rule.
            const prevEntry = uid && prevLayout?.windows.get(uid);
            let workspace = global.workspace_manager.get_active_workspace_index();
            if (prevEntry && !prevEntry.onAllWorkspaces && prevEntry.workspace >= 0)
                workspace = prevEntry.workspace;
            else if (prevLayout)
                workspace = prevLayout.activeWorkspace;

            const remembered = this._settings.get_boolean('remember-app-positions') &&
                !this._hasOtherWindow(win) &&
                this._appPositions.get(this._appKey(win))?.get(info.key);
            if (remembered && this._applyEntry(win, {...remembered, workspace}, info))
                continue;

            if (info.laptopOnly)
                this._placeLaptop(win, workspace);
            else
                this._placeExternal(win, workspace);
        }
    }

    // Returns false if the entry's monitor isn't connected.
    _applyEntry(win, entry, info) {
        const index = this._monitorIndex(info, entry.monitor);
        if (index === undefined)
            return false;

        debug(`restore "${win.get_title()}" ws=${entry.workspace} mon=${entry.monitor} max=${entry.maximized}`);
        if (entry.maximized) {
            if (win.get_monitor() !== index)
                win.move_to_monitor(index);
            if (!win.is_maximized())
                win.maximize();
        } else {
            if (win.is_maximized())
                win.unmaximize();
            // Positions are relative to the monitor; keep the window fully
            // visible in case its resolution or scale changed since.
            const monitor = global.display.get_monitor_geometry(index);
            const area = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(index);
            const {x, y, width, height} = fitInto(area, {
                x: monitor.x + entry.x,
                y: monitor.y + entry.y,
                width: entry.width,
                height: entry.height,
            });
            win.move_resize_frame(true, x, y, width, height);
        }

        if (!entry.onAllWorkspaces && entry.workspace >= 0)
            this._moveToWorkspace(win, entry.workspace);
        return true;
    }

    _placeExternal(win, workspace) {
        debug(`place "${win.get_title()}" on primary monitor, ws=${workspace}`);
        const primary = global.display.get_primary_monitor();
        const area = global.workspace_manager.get_active_workspace()
            .get_work_area_for_monitor(primary);

        if (win.is_maximized())
            win.unmaximize();

        let {width, height} = win.get_frame_rect();
        if (win.allows_resize()) {
            width = Math.round(area.width * EXTERNAL_SIZE_RATIO);
            height = Math.round(area.height * EXTERNAL_SIZE_RATIO);
        }
        const x = area.x + Math.round((area.width - width) / 2);
        const y = area.y + Math.round((area.height - height) / 2);
        win.move_resize_frame(true, x, y, width, height);

        this._moveToWorkspace(win, workspace);
    }

    _placeLaptop(win, workspace) {
        debug(`place "${win.get_title()}" on laptop, ws=${workspace}`);
        this._moveToWorkspace(win, workspace);
        if (win.can_maximize() && !win.is_maximized())
            win.maximize();
    }

    _moveToWorkspace(win, index) {
        if (win.is_always_on_all_workspaces())
            return;
        const last = global.workspace_manager.get_n_workspaces() - 1;
        index = Math.min(index, last);
        // A window on the secondary monitor is on all workspaces, and its
        // reported workspace can coincidentally match: move it regardless.
        const current = win.get_workspace()?.index();
        if (current === index && !win.is_on_all_workspaces())
            return;
        debug(`  move "${win.get_title()}" ws ${win.is_on_all_workspaces() ? 'all' : current} -> ${index}`);
        win.change_workspace_by_index(index, false);
    }

    // Warns once per distinct set of issues, not at every login.
    _notifyCompatibility() {
        const issues = compatibilityIssues();
        const ids = issues.map(issue => issue.id).sort().join(',');
        if (ids === this._settings.get_string('notified-issues'))
            return;
        this._settings.set_string('notified-issues', ids);
        if (!issues.length)
            return;
        debug(`compatibility issues: ${ids}`);
        Main.notify('Dynamic Window Position',
            `${issues.map(issue => issue.title).join('. ')}. See the extension settings for details.`);
    }
}

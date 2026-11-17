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
// Same monitors but a different primary than any saved setup is usually a
// dock's intermediate config, or Mutter's fallback when the stored monitor
// configuration can't be applied. If it persists this long, accept it as a
// setup of its own: it starts from the other primary's layout but is saved
// separately, so it never overwrites it.
const PRIMARY_MISMATCH_FALLBACK_MS = 8000;
// Earlier versions of each setup's layout kept for "Restore previous layout".
const MAX_BACKUPS = 3;
// A restore that ran while the screen was locked (typically after resume) is
// applied again this long after unlocking: some apps rearrange their windows
// once they become visible again (seen with Slack, 2026-11-13, ~2 s after
// unlock). Snapshots are held until then so that move isn't saved.
const UNLOCK_REPASS_MS = 4000;

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

// Workspace index as the restore log lines show it ("ws 0" is the first),
// or "all" for a window on every workspace.
function workspaceLabel(win) {
    if (win.is_on_all_workspaces())
        return 'all';
    return String(win.get_workspace()?.index() ?? -1);
}

function savedWorkspaceLabel(entry) {
    return entry.onAllWorkspaces ? 'all' : String(entry.workspace);
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

// A setup is the connected monitors plus, when there are several, which one
// is primary, e.g. "SAM:U32J59x:H4ZMC00130 + builtin (primary builtin)".
const PRIMARY_SUFFIX = ' (primary ';

function setupKey(monitors, primary) {
    return monitors.includes(' + ') ? `${monitors}${PRIMARY_SUFFIX}${primary})` : monitors;
}

function monitorsOf(key) {
    const i = key.lastIndexOf(PRIMARY_SUFFIX);
    return i < 0 ? key : key.slice(0, i);
}

function layoutToJson(layout) {
    return {
        primary: layout.primary,
        activeWorkspace: layout.activeWorkspace,
        windows: Object.fromEntries(layout.windows),
    };
}

function layoutFromJson(json) {
    return {
        primary: json.primary ?? null,
        activeWorkspace: json.activeWorkspace ?? 0,
        windows: new Map(Object.entries(json.windows ?? {})),
    };
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
            'changed::restore-previous-request', () => this._restorePrevious(),
            this);
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});

        // Setups are keyed by the connected monitors and the primary one
        // (see setupKey); window positions are relative to their monitor.
        this._layouts = new Map(); // setup key -> { primary, activeWorkspace, windows: Map<uid, entry> }
        this._backups = new Map(); // setup key -> [{ savedAt, layout }], newest first
        // Workspace each window last had where it wasn't forced onto all
        // workspaces by being on a non-primary monitor (see _workspaceOf).
        this._lastWorkspace = new Map(); // uid -> { workspace, onAllWorkspaces }
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
        // Windows the user moved or resized with the mouse or keyboard: later
        // placement passes leave them alone.
        this._userPlaced = new Set();
        this._timeouts = new Set();
        this._placementUntil = 0;
        this._restoring = false;
        this._applying = false; // inside _applyEntry, for debug lines
        this._burstStart = this._burstEnd = 0;
        this._saveId = this._restoreId = this._secondPassId = this._graceId = this._unlockId = 0;
        this._holdSaves = false; // until the after-unlock pass (see UNLOCK_REPASS_MS)
        this._restoredWhileLocked = false;
        this._lastApplied = null; // layout the last restore applied
        this._windowMonitors = new Map(); // Meta.Window -> monitor id, for logging moves
        this._windowWorkspaces = new Map(); // Meta.Window -> workspace label, for logging moves
        this._currentKey = this._monitorInfo().key;
        this._locked = Main.sessionMode.isLocked;

        global.display.connectObject(
            'window-created', (_display, win) => this._onWindowCreated(win),
            'grab-op-begin', (_display, win) => this._onGrabOpBegin(win),
            this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._onMonitorsChanged(),
            this);
        Main.sessionMode.connectObject(
            'updated', () => this._onSessionModeUpdated(),
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
        Main.sessionMode.disconnectObject(this);

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
        this._mutterSettings = null;
        this._layouts = null;
        this._backups = null;
        this._lastWorkspace = null;
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
        this._userPlaced = null;
        this._timeouts = null;
        this._windowMonitors = null;
        this._windowWorkspaces = null;
        this._lastApplied = null;
        this._restoring = false;
    }

    _cancelTimers() {
        for (const id of [this._saveId, this._restoreId, this._secondPassId, this._graceId, this._unlockId]) {
            if (id)
                GLib.Source.remove(id);
        }
        this._saveId = this._restoreId = this._secondPassId = this._graceId = this._unlockId = 0;
        this._holdSaves = false;
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

    // key: the setup (see setupKey); monitors: the connected monitors, e.g.
    // "SAM:U32J59x:H4ZMC00130 + builtin"; primary: id of the primary
    // monitor; ids: monitor index -> id.
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
        const monitors = all.join(' + ');
        const primary = ids.get(global.display.get_primary_monitor()) ?? null;
        return {
            key: setupKey(monitors, primary),
            monitors,
            primary,
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

    // GNOME can take a moment to link a new window to its app, for example
    // a snap started through a wrapper script (Slack, 2026-11-17): until
    // then it reports a window-backed app. Fall back to the desktop file
    // whose StartupWMClass or name matches the window's WM class.
    _appId(win) {
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        if (app && !app.is_window_backed())
            return app.get_id();
        const wmClass = win.get_wm_class();
        if (!wmClass)
            return null;
        const appSystem = Shell.AppSystem.get_default();
        const byClass = appSystem.lookup_startup_wmclass(wmClass) ??
            appSystem.lookup_desktop_wmclass(wmClass);
        return byClass?.get_id() ?? null;
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
        this._lastWorkspace.delete(uid);
    }

    _trackWindow(win) {
        if (this._tracked.has(win))
            return;
        this._tracked.add(win);

        win.connectObject(
            'position-changed', () => this._queueSave(),
            'size-changed', () => this._queueSave(),
            'workspace-changed', () => {
                this._onWindowWorkspaceChanged(win);
                this._queueSave();
            },
            'notify::main-monitor', () => this._onWindowMonitorChanged(win),
            'unmanaged', () => this._onUnmanaged(win),
            this);
        this._windowMonitors.set(win, this._monitorIdOf(win));
        this._windowWorkspaces.set(win, workspaceLabel(win));
    }

    // Debug only, like _onWindowMonitorChanged. "focused" hints at the
    // move-window-to-workspace shortcuts, which take the focused window along.
    _onWindowWorkspaceChanged(win) {
        const to = workspaceLabel(win);
        const from = this._windowWorkspaces.get(win) ?? null;
        this._windowWorkspaces.set(win, to);
        if (!debugEnabled || from === to || !this._isManageable(win))
            return;
        const by = this._moveContext();
        const active = global.workspace_manager.get_active_workspace_index();
        const focus = win.has_focus() ? ', focused' : '';
        debug(`"${win.get_title()}" changed workspace ${from} -> ${to} (${by}, active ws ${active}${focus})`);
    }

    _monitorIdOf(win) {
        const index = win.get_monitor();
        return index < 0 ? null : this._monitorInfo().ids.get(index) ?? null;
    }

    // Debug only: says which window changed monitor and whether this
    // extension was moving windows at the time, to tell its moves apart
    // from GNOME's and the apps' own.
    _onWindowMonitorChanged(win) {
        const to = this._monitorIdOf(win);
        const from = this._windowMonitors.get(win) ?? null;
        this._windowMonitors.set(win, to);
        if (!debugEnabled || from === to || !this._isManageable(win))
            return;
        const by = this._moveContext();
        const lock = Main.sessionMode.isLocked ? ', screen locked' : '';
        debug(`"${win.get_title()}" changed monitor ${from} -> ${to} (${by}${lock}, maximized=${win.is_maximized()})`);
    }

    // For the debug lines about windows changing monitor or workspace.
    _moveContext() {
        if (this._restoring)
            return 'during a restore';
        if (this._applying)
            return 'during placement';
        return 'outside a restore';
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
            debug(`no last-session match for "${win.get_title()}" (app ${this._appId(win)}, class ${win.get_wm_class()})`);
        }

        if (this._settings.get_boolean('remember-app-positions') && !this._restoring &&
            !this._hasOtherWindow(win))
            this._placeFromApp(win);
    }

    // Puts an app's first window where its last closed window was in this
    // setup, but on the current workspace.
    _placeFromApp(win) {
        const remembered = this._appPositions.get(this._appKey(win))?.get(this._currentKey);
        if (!remembered) {
            debug(`"${win.get_title()}": no remembered position for ${this._appKey(win)} in this setup`);
            return;
        }
        debug(`"${win.get_title()}" opens where its app was last closed`);
        const entry = {...remembered, workspace: -1};
        this._runPlacementPasses(win, () => {
            if (!this._restoring && this._tracked.has(win))
                this._applyEntry(win, entry, this._monitorInfo());
        });
    }

    // Runs apply now and again at each of MATCH_PASSES_MS, to catch clients
    // that move their window after it appears. Stops once the user moves or
    // resizes the window themselves, so it doesn't snap back.
    _runPlacementPasses(win, apply) {
        for (const ms of MATCH_PASSES_MS) {
            const pass = () => {
                if (this._userPlaced.has(win)) {
                    debug(`"${win.get_title()}" was moved by the user; skipping the ${ms} ms placement pass`);
                    return;
                }
                apply();
            };
            if (ms === 0)
                pass();
            else
                this._timeout(ms, pass);
        }
    }

    _onGrabOpBegin(win) {
        if (win && this._tracked.has(win))
            this._userPlaced.add(win);
    }

    _onUnmanaged(win) {
        win.disconnectObject(this);
        this._tracked.delete(win);
        this._windowMonitors.delete(win);
        this._windowWorkspaces.delete(win);
        this._userPlaced.delete(win);
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
        if (this._restoring || this._holdSaves)
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
        if (this._restoring || this._holdSaves)
            return;
        // The monitors changed but the restore hasn't run yet: whatever is
        // on screen now is Mutter's shuffle, not a layout worth keeping.
        const info = this._monitorInfo();
        if (info.key !== this._currentKey)
            return;

        const current = this._layouts.get(this._currentKey);
        const previous = current?.windows;
        const windows = new Map();
        for (const win of this._windows()) {
            const uid = this._uidFor(win);
            const index = win.get_monitor();
            const monitor = global.display.get_monitor_geometry(index);
            const rect = win.get_frame_rect();
            const entry = {
                monitor: info.ids.get(index) ?? null,
                x: rect.x - monitor.x,
                y: rect.y - monitor.y,
                width: rect.width,
                height: rect.height,
                maximized: win.is_maximized(),
                ...this._workspaceOf(win, uid, current),
            };
            windows.set(uid, entry);
            const old = previous?.get(uid);
            if (old && (old.workspace !== entry.workspace || old.onAllWorkspaces !== entry.onAllWorkspaces))
                debug(`saved "${win.get_title()}" ws ${savedWorkspaceLabel(old)} -> ${savedWorkspaceLabel(entry)}`);
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

    // With workspaces on the primary display only, a window on another
    // monitor is on all workspaces whatever workspace it belongs to. Saving
    // that would lose its workspace, so keep the one it last had on the
    // primary display: seen live this session, else in a saved layout where
    // it was on that layout's primary monitor.
    _workspaceOf(win, uid, current) {
        const forcedOnAll = win.is_on_all_workspaces() && !win.is_on_primary_monitor() &&
            this._mutterSettings.get_boolean('workspaces-only-on-primary');
        if (!forcedOnAll) {
            const real = {
                workspace: win.get_workspace()?.index() ?? -1,
                onAllWorkspaces: win.is_on_all_workspaces(),
            };
            this._lastWorkspace.set(uid, real);
            return real;
        }

        const live = this._lastWorkspace.get(uid);
        if (live)
            return live;
        for (const layout of [current, ...this._layouts.values()]) {
            const entry = layout?.windows.get(uid);
            if (entry && entry.monitor === layout.primary)
                return {workspace: entry.workspace, onAllWorkspaces: entry.onAllWorkspaces};
        }
        return {workspace: -1, onAllWorkspaces: false};
    }

    // Session state on disk

    _persist() {
        const layouts = {};
        for (const [key, layout] of this._layouts)
            layouts[key] = layoutToJson(layout);
        const state = {
            version: STATE_VERSION,
            shellPid: shellPid(),
            savedAt: new Date().toISOString(),
            layouts,
            backups: Object.fromEntries(this._backups),
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

        // Setups used to be keyed by the monitors alone; add the primary
        // they were saved with.
        const rekeyed = new Map();
        for (const [key, layout] of Object.entries(state.layouts ?? {})) {
            const newKey = monitorsOf(key) === key && layout.primary
                ? setupKey(key, layout.primary) : key;
            rekeyed.set(key, newKey);
            this._layouts.set(newKey, layoutFromJson(layout));
        }
        for (const [key, backups] of Object.entries(state.backups ?? {}))
            this._backups.set(key, backups);
        for (const [app, positions] of Object.entries(state.appPositions ?? {})) {
            this._appPositions.set(app, new Map(Object.entries(positions)
                .map(([setup, entry]) => [rekeyed.get(setup) ?? setup, entry])));
        }
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
            const sameApp = identity?.app && appId ? identity.app === appId : identity?.wmClass === wmClass;
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

        this._runPlacementPasses(win, apply);
    }

    // Monitor hotplug

    _onMonitorsChanged() {
        const info = this._monitorInfo();
        debug(`monitors changed: ${info.key}`);

        // First change of a burst: keep the layout being left as it is now.
        if (!this._restoring)
            this._backup(this._currentKey);

        const now = GLib.get_monotonic_time() / 1000;
        if (!this._burstStart)
            this._burstStart = now;
        this._burstEnd = now;

        // Restarts the whole restore cycle, including an unfinished settle
        // period: nothing has been saved since the last settled setup, so
        // its layouts are still intact.
        this._restoring = true;
        this._cancelTimers();
        if (Main.sessionMode.isLocked)
            this._restoredWhileLocked = true;
        this._scheduleRestore(RESTORE_DELAY_MS, false);
    }

    // After resume the restore usually runs on the lock screen. Some apps
    // rearrange their windows once the session is visible again, so apply
    // the restored layout once more shortly after unlock, and save nothing
    // in between (see UNLOCK_REPASS_MS).
    _onSessionModeUpdated() {
        const wasLocked = this._locked;
        this._locked = Main.sessionMode.isLocked;
        if (!wasLocked || this._locked || !this._restoredWhileLocked)
            return;
        this._restoredWhileLocked = false;
        debug(`unlocked after a restore on the lock screen: applying it again in ${UNLOCK_REPASS_MS} ms`);
        this._holdSaves = true;
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = 0;
        }
        this._scheduleUnlockPass(UNLOCK_REPASS_MS);
    }

    _scheduleUnlockPass(delay) {
        this._unlockId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._unlockId = 0;
            // The restore itself hasn't settled yet: wait for it.
            if (this._restoring) {
                this._scheduleUnlockPass(SECOND_PASS_DELAY_MS);
                return GLib.SOURCE_REMOVE;
            }
            const applied = this._lastApplied;
            if (!applied || applied.key !== this._currentKey) {
                this._holdSaves = false;
                this._save();
                return GLib.SOURCE_REMOVE;
            }
            debug('after-unlock pass');
            this._restoring = true;
            this._applyLayout(applied.layout, null, true);
            this._unlockId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SECOND_PASS_DELAY_MS, () => {
                this._unlockId = 0;
                this._applyLayout(applied.layout, null, true);
                this._restoring = false;
                this._holdSaves = false;
                this._save();
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
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

        let layout = this._layouts.get(info.key);
        let note = '';
        if (!layout) {
            const siblingKey = [...this._layouts.keys()]
                .find(key => key !== info.key && monitorsOf(key) === info.monitors);
            if (siblingKey && !isFallback) {
                debug(`primary is ${info.primary}, but these monitors were saved with primary ${this._layouts.get(siblingKey).primary}: waiting`);
                this._scheduleRestore(Math.max(PRIMARY_MISMATCH_FALLBACK_MS, this._settleMs()), true);
                return;
            }
            // Accepted as a setup of its own: start from the other primary's
            // layout; snapshots go to this setup's key from now on.
            layout = siblingKey ? this._layouts.get(siblingKey) : null;
            note = siblingKey ? ` (new setup, starting from ${siblingKey})` : ' (new setup)';
        }

        const fromKey = this._currentKey;
        const key = info.key;
        const prevLayout = fromKey !== key ? this._layouts.get(fromKey) : null;
        debug(`restoring ${fromKey} -> ${key}${note}`);
        this._lastApplied = {key, layout};

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

    // Keeps a copy of a setup's layout, so a layout overwritten by mistake
    // can be brought back from the settings.
    _backup(key) {
        const layout = this._layouts.get(key);
        if (!layout?.windows.size)
            return;
        const json = layoutToJson(layout);
        const backups = this._backups.get(key) ?? [];
        if (backups.length && JSON.stringify(backups[0].layout) === JSON.stringify(json))
            return;
        backups.unshift({savedAt: new Date().toISOString(), layout: json});
        this._backups.set(key, backups.slice(0, MAX_BACKUPS));
        this._persist();
    }

    // Puts the current setup's newest backup in place and moves the current
    // layout to the end of the list, so pressing again goes further back and
    // eventually returns to where it started.
    _restorePrevious() {
        const key = this._currentKey;
        const backups = this._backups.get(key);
        if (this._restoring || !backups?.length) {
            Main.notify('Dynamic Window Position', this._restoring
                ? 'Monitors are changing; try again in a few seconds.'
                : 'No earlier layout is saved for this monitor setup.');
            return;
        }

        const {savedAt, layout} = backups.shift();
        const current = this._layouts.get(key);
        if (current?.windows.size)
            backups.push({savedAt: new Date().toISOString(), layout: layoutToJson(current)});
        const restored = layoutFromJson(layout);
        this._layouts.set(key, restored);
        this._persist();
        debug(`restoring the layout of ${key} saved ${savedAt}`);

        // Same passes as a monitor change, without the settle wait.
        this._cancelTimers();
        this._restoring = true;
        this._applyLayout(restored, null, true);
        this._secondPassId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SECOND_PASS_DELAY_MS, () => {
            this._applyLayout(restored, null, true);
            this._secondPassId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MIN_SETTLE_MS, () => {
                this._secondPassId = 0;
                this._applyLayout(restored, null, true);
                this._restoring = false;
                this._save();
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });

        const when = GLib.DateTime.new_from_iso8601(savedAt, null)?.to_local().format('%a %H:%M') ?? savedAt;
        Main.notify('Dynamic Window Position', `Restored the layout from ${when}.`);
    }

    // With onlySaved, windows not in the layout are left alone.
    _applyLayout(layout, prevLayout, onlySaved = false) {
        const info = this._monitorInfo();
        for (const win of this._windows()) {
            const uid = this._uids.get(win.get_stable_sequence());
            const entry = uid && layout?.windows.get(uid);
            if (entry && this._applyEntry(win, entry, info))
                continue;
            if (onlySaved)
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
        this._applying = true;
        try {
            return this._applyEntryNow(win, entry, info);
        } finally {
            this._applying = false;
        }
    }

    _applyEntryNow(win, entry, info) {
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
        const wasApplying = this._applying;
        this._applying = true;
        try {
            win.change_workspace_by_index(index, false);
        } finally {
            this._applying = wasApplying;
        }
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

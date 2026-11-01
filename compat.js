// Settings and extensions known to interfere with window restoring. Shared
// by the extension (one-time notification) and the preferences window.

import Gio from 'gi://Gio';

// Extensions that also move, resize or restore windows.
const CONFLICTING_EXTENSIONS = {
    'forge@jmmaranan.com': 'Forge',
    'paperwm@paperwm.github.com': 'PaperWM',
    'pop-shell@system76.com': 'Pop Shell',
    'tilingshell@ferrarodomenico.com': 'Tiling Shell',
    'gTile@vibou': 'gTile',
    'tiling-assistant@leleat-on-github': 'Tiling Assistant',
    'tiling-assistant@ubuntu.com': 'Ubuntu Tiling Assistant',
    'smart-auto-move@khimaros.com': 'Smart Auto Move',
    'another-window-session-manager@gmail.com': 'Another Window Session Manager',
    'auto-move-windows@gnome-shell-extensions.gcampax.github.com': 'Auto Move Windows',
};

// Returns [{id, title, description, fix?}]. `fix` changes the setting that
// causes the issue; only offered for GNOME settings, not other extensions.
export function compatibilityIssues() {
    const issues = [];
    const mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});

    if (mutter.get_boolean('dynamic-workspaces')) {
        issues.push({
            id: 'dynamic-workspaces',
            title: 'Dynamic workspaces are on',
            description: 'GNOME removes empty workspaces when windows move between screens, which renumbers the others and sends windows to the wrong workspace.',
            fixLabel: 'Use Fixed Workspaces',
            fix: () => mutter.set_boolean('dynamic-workspaces', false),
        });
    }
    if (!mutter.get_boolean('workspaces-only-on-primary')) {
        issues.push({
            id: 'workspaces-on-all-displays',
            title: 'Workspaces span all displays',
            description: 'Only "workspaces on primary display only" has been tested; windows on other displays may not return to the right workspace.',
            fixLabel: 'Primary Display Only',
            fix: () => mutter.set_boolean('workspaces-only-on-primary', true),
        });
    }

    const shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
    if (!shell.get_boolean('disable-user-extensions')) {
        const enabled = new Set(shell.get_strv('enabled-extensions'));
        for (const [uuid, name] of Object.entries(CONFLICTING_EXTENSIONS)) {
            if (!enabled.has(uuid))
                continue;
            issues.push({
                id: `extension:${uuid}`,
                title: `${name} may conflict`,
                description: `${name} also moves or restores windows. If windows end up in the wrong place, try disabling it.`,
            });
        }
    }
    return issues;
}

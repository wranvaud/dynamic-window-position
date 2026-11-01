import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {compatibilityIssues} from './compat.js';

export default class DynamicWindowPositionPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive with the window

        const page = new Adw.PreferencesPage();
        window.add(page);

        this._addCompatibilityGroup(page, window);

        // Session restore
        const sessionGroup = new Adw.PreferencesGroup({
            title: 'Session Restore',
            description: 'At login, reopen the apps from the last session and put their windows back where they were.',
        });
        page.add(sessionGroup);

        const restoreRow = new Adw.SwitchRow({title: 'Restore last session at login'});
        settings.bind('restore-session', restoreRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        sessionGroup.add(restoreRow);

        const delayRow = this._intSpinRow(settings, 'launch-delay', 0, 120, {
            title: 'Delay before reopening apps',
            subtitle: 'Seconds after login, so autostart apps open first',
        });
        restoreRow.bind_property('active', delayRow, 'sensitive', 0);
        delayRow.sensitive = restoreRow.active;
        sessionGroup.add(delayRow);

        // Ignored apps
        const ignoredGroup = new Adw.PreferencesGroup({
            title: 'Apps Not Reopened',
            description: 'These apps are never launched at login. If they open anyway, their windows are still put back in place.',
        });
        page.add(ignoredGroup);
        restoreRow.bind_property('active', ignoredGroup, 'sensitive', 0);
        ignoredGroup.sensitive = restoreRow.active;

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add app',
            css_classes: ['flat'],
        });
        addButton.connect('clicked', () => this._showAppPicker(window, settings));
        ignoredGroup.set_header_suffix(addButton);

        const ignoredRows = [];
        const refreshIgnored = () => {
            for (const row of ignoredRows.splice(0))
                ignoredGroup.remove(row);

            const ids = settings.get_strv('ignored-apps');
            if (!ids.length) {
                const empty = new Adw.ActionRow({title: 'No apps ignored', css_classes: ['dim-label']});
                ignoredRows.push(empty);
                ignoredGroup.add(empty);
                return;
            }
            for (const id of ids) {
                const info = Gio.DesktopAppInfo.new(id);
                const row = new Adw.ActionRow({
                    title: info?.get_display_name() ?? id,
                    subtitle: id,
                });
                if (info?.get_icon())
                    row.add_prefix(new Gtk.Image({gicon: info.get_icon(), pixel_size: 32}));

                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Remove',
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    settings.set_strv('ignored-apps',
                        settings.get_strv('ignored-apps').filter(x => x !== id));
                });
                row.add_suffix(remove);
                ignoredRows.push(row);
                ignoredGroup.add(row);
            }
        };
        settings.connect('changed::ignored-apps', refreshIgnored);
        refreshIgnored();

        // Layout
        const layoutGroup = new Adw.PreferencesGroup({
            title: 'Monitor Layouts',
            description: 'Each combination of monitors keeps its own layout. When a window has no saved position in the new setup, it is maximized on the laptop screen alone, or centered on the primary external monitor at 60 % of its size.',
        });
        page.add(layoutGroup);

        this._addSettleRows(layoutGroup, settings);

        // Debugging
        const debugGroup = new Adw.PreferencesGroup({title: 'Troubleshooting'});
        page.add(debugGroup);
        const debugRow = new Adw.SwitchRow({
            title: 'Debug logging',
            subtitle: 'journalctl -f -o cat /usr/bin/gnome-shell | grep dynamic-window-position',
        });
        settings.bind('debug-logging', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        debugGroup.add(debugRow);
    }

    // Shown only while there are issues; refreshes when they change.
    _addCompatibilityGroup(page, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Compatibility',
            description: 'These can stop windows from returning to their place.',
        });
        page.add(group);

        const rows = [];
        const refresh = () => {
            for (const row of rows.splice(0))
                group.remove(row);

            const issues = compatibilityIssues();
            group.visible = issues.length > 0;
            for (const issue of issues) {
                const row = new Adw.ActionRow({title: issue.title, subtitle: issue.description});
                row.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
                if (issue.fix) {
                    const button = new Gtk.Button({label: issue.fixLabel, valign: Gtk.Align.CENTER});
                    button.connect('clicked', () => issue.fix());
                    row.add_suffix(button);
                }
                rows.push(row);
                group.add(row);
            }
        };

        // Kept on the window so the change signals stay connected.
        window._compatSettings = [
            new Gio.Settings({schema_id: 'org.gnome.mutter'}),
            new Gio.Settings({schema_id: 'org.gnome.shell'}),
        ];
        for (const watched of window._compatSettings)
            watched.connect('changed', refresh);
        refresh();
    }

    _addSettleRows(group, settings) {
        const measuredMs = () => {
            const recent = settings.get_value('recent-settle-ms').deepUnpack();
            return recent.length ? Math.max(...recent) : null;
        };

        const autoRow = new Adw.SwitchRow({title: 'Measure monitor settle time automatically'});
        const waitRow = Adw.SpinRow.new_with_range(1, 30, 1);
        waitRow.set({
            title: 'Wait for monitors to settle',
            subtitle: 'Seconds. Increase if windows end up misplaced after connecting a dock.',
        });

        const sync = () => {
            const configured = settings.get_int('settle-delay');
            const measured = measuredMs();
            autoRow.active = configured === 0;
            autoRow.subtitle = measured === null
                ? 'Not measured yet: connect or disconnect a monitor'
                : `Your monitors took up to ${(measured / 1000).toFixed(1)} s to settle`;
            waitRow.sensitive = configured !== 0;
            if (configured !== 0)
                waitRow.value = configured;
        };
        sync();
        settings.connect('changed::settle-delay', sync);
        settings.connect('changed::recent-settle-ms', sync);

        autoRow.connect('notify::active', () => {
            if (autoRow.active === (settings.get_int('settle-delay') === 0))
                return;
            // Switching to manual starts from what was measured, plus margin.
            const measured = measuredMs() ?? 0;
            settings.set_int('settle-delay',
                autoRow.active ? 0 : Math.min(30, Math.max(5, Math.ceil(measured / 1000) + 2)));
        });
        waitRow.connect('notify::value', () => {
            if (settings.get_int('settle-delay') !== 0)
                settings.set_int('settle-delay', waitRow.value);
        });

        group.add(autoRow);
        group.add(waitRow);
    }

    _intSpinRow(settings, key, min, max, props) {
        const row = Adw.SpinRow.new_with_range(min, max, 1);
        row.set({...props, value: settings.get_int(key)});
        row.connect('notify::value', () => settings.set_int(key, row.value));
        return row;
    }

    _showAppPicker(window, settings) {
        const dialog = new Adw.Dialog({title: 'Add App', content_width: 420, content_height: 560});

        const search = new Gtk.SearchEntry({placeholder_text: 'Search apps', margin_start: 12, margin_end: 12, margin_bottom: 6});
        const list = new Gtk.ListBox({css_classes: ['boxed-list'], margin_start: 12, margin_end: 12, margin_bottom: 12, valign: Gtk.Align.START});
        list.set_selection_mode(Gtk.SelectionMode.NONE);

        const ignored = new Set(settings.get_strv('ignored-apps'));
        const apps = Gio.AppInfo.get_all()
            .filter(info => info.should_show() && !ignored.has(info.get_id()))
            .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));

        for (const info of apps) {
            const row = new Adw.ActionRow({
                title: info.get_display_name(),
                subtitle: info.get_id(),
                activatable: true,
            });
            if (info.get_icon())
                row.add_prefix(new Gtk.Image({gicon: info.get_icon(), pixel_size: 32}));
            row.connect('activated', () => {
                settings.set_strv('ignored-apps', [...settings.get_strv('ignored-apps'), info.get_id()]);
                dialog.close();
            });
            row._search = `${info.get_display_name()} ${info.get_id()}`.toLowerCase();
            list.append(row);
        }
        list.set_filter_func(row => row._search.includes(search.text.toLowerCase()));
        search.connect('search-changed', () => list.invalidate_filter());

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(search);
        box.append(new Gtk.ScrolledWindow({child: list, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER}));

        const toolbar = new Adw.ToolbarView({content: box});
        toolbar.add_top_bar(new Adw.HeaderBar());
        dialog.set_child(toolbar);
        dialog.present(window);
    }
}

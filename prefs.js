import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ResourceWatcherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const generalGroup = new Adw.PreferencesGroup({title: 'General'});

        const intervalRow = new Adw.SpinRow({
            title: 'Update interval',
            subtitle: 'Seconds between refreshes (1–300)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 300,
                step_increment: 1,
                page_increment: 10,
            }),
        });
        intervalRow.value = settings.get_int('update-interval');
        intervalRow.connect('notify::value', () => {
            const value = Math.round(intervalRow.value);
            if (value !== settings.get_int('update-interval'))
                settings.set_int('update-interval', value);
        });
        settings.connect('changed::update-interval', () => {
            const value = settings.get_int('update-interval');
            if (Math.round(intervalRow.value) !== value)
                intervalRow.value = value;
        });
        generalGroup.add(intervalRow);

        const showGroup = new Adw.PreferencesGroup({
            title: 'Top bar',
            description: 'Choose which readings appear in the panel and the popup menu.',
        });
        for (const [key, title] of [
            ['show-cpu', 'CPU usage'],
            ['show-ram', 'RAM usage'],
            ['show-disk', 'Disk usage'],
        ]) {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            showGroup.add(row);
        }

        const diskGroup = new Adw.PreferencesGroup({
            title: 'Disk',
            description: 'Filesystem whose usage is displayed, for example "/" or "/home".',
        });
        const diskPathRow = new Adw.EntryRow({title: 'Filesystem path'});
        settings.bind('disk-path', diskPathRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        diskGroup.add(diskPathRow);

        const page = new Adw.PreferencesPage({
            title: 'Resource Watcher',
            icon_name: 'utilities-system-monitor-symbolic',
        });
        page.add(generalGroup);
        page.add(showGroup);
        page.add(diskGroup);
        window.add(page);
    }
}

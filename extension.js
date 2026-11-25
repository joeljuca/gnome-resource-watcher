import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    cpuUsage,
    formatBytes,
    memoryUsagePercent,
    panelSegment,
    queryDiskUsage,
    readCpuTimes,
    readMemory,
} from './lib.js';

// Refresh shortly after enabling so the CPU reading appears without
// waiting a full update interval.
const PRIME_DELAY_MS = 1000;

const WARN_THRESHOLD = 75;
const CRIT_THRESHOLD = 90;

const MetricRow = GObject.registerClass(
class MetricRow extends PopupMenu.PopupBaseMenuItem {
    _init(title) {
        super._init({reactive: false, can_focus: false});

        this._textBox = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // GNOME 51 dropped St.BoxLayout::vertical in favour of orientation;
        // older shells only know vertical.
        if (this._textBox.orientation !== undefined)
            this._textBox.orientation = Clutter.Orientation.VERTICAL;
        else
            this._textBox.vertical = true;
        this._title = new St.Label({text: title, style_class: 'rw-row-title'});
        this._detail = new St.Label({text: '', style_class: 'rw-row-detail', visible: false});
        this._textBox.add_child(this._title);
        this._textBox.add_child(this._detail);
        this.add_child(this._textBox);

        this._value = new St.Label({
            text: '',
            style_class: 'rw-row-value',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._value);
    }

    update(detail, percent) {
        this._detail.text = detail ?? '';
        this._detail.visible = Boolean(detail);

        this._value.text = percent === null || !Number.isFinite(percent)
            ? '—'
            : `${Math.round(percent)}%`;

        this._value.remove_style_class_name('rw-warn');
        this._value.remove_style_class_name('rw-crit');
        if (percent !== null && Number.isFinite(percent)) {
            if (percent >= CRIT_THRESHOLD)
                this._value.add_style_class_name('rw-crit');
            else if (percent >= WARN_THRESHOLD)
                this._value.add_style_class_name('rw-warn');
        }
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.0, 'Resource Watcher');

        this._extension = extension;
        this._settings = settings;
        this._destroyed = false;
        this._diskInFlight = false;
        this._diskCancellable = new Gio.Cancellable();
        this._settingsIds = [];

        this._cpu = null;
        this._cpuPrevious = readCpuTimes();
        this._memory = null;
        this._disk = null;
        this._diskPath = settings.get_string('disk-path') || '/';

        this._label = new St.Label({
            text: '',
            style_class: 'rw-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._cpuRow = new MetricRow('CPU');
        this._memoryRow = new MetricRow('RAM');
        this._diskRow = new MetricRow('Disk');
        this.menu.addMenuItem(this._cpuRow);
        this.menu.addMenuItem(this._memoryRow);
        this.menu.addMenuItem(this._diskRow);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const preferencesItem = new PopupMenu.PopupMenuItem('Preferences');
        preferencesItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(preferencesItem);

        for (const key of ['show-cpu', 'show-ram', 'show-disk']) {
            this._settingsIds.push(this._settings.connect(`changed::${key}`,
                () => this._render()));
        }
        this._settingsIds.push(this._settings.connect('changed::disk-path', () => {
            this._diskPath = this._settings.get_string('disk-path') || '/';
            this._disk = null;
            this._render();
            this._refreshDisk();
        }));

        this._render();
    }

    /**
     * Take a fresh reading and refresh the UI. Called by the extension's
     * timer.
     */
    update() {
        if (this._destroyed)
            return;

        const current = readCpuTimes();
        if (current) {
            const usage = cpuUsage(this._cpuPrevious, current);
            if (usage !== null)
                this._cpu = usage;
            this._cpuPrevious = current;
        }

        const memory = readMemory();
        if (memory)
            this._memory = memory;

        this._render();
        this._refreshDisk();
    }

    _refreshDisk() {
        if (this._diskInFlight || this._destroyed)
            return;

        this._diskInFlight = true;
        queryDiskUsage(this._diskPath, this._diskCancellable, disk => {
            this._diskInFlight = false;
            if (this._destroyed)
                return;
            if (disk)
                this._disk = {...disk, path: this._diskPath};
            this._render();
        });
    }

    _render() {
        const showCpu = this._settings.get_boolean('show-cpu');
        const showMemory = this._settings.get_boolean('show-ram');
        const showDisk = this._settings.get_boolean('show-disk');

        const segments = [];
        if (showCpu)
            segments.push(panelSegment('CPU', this._cpu));
        if (showMemory)
            segments.push(panelSegment('RAM', memoryUsagePercent(this._memory)));
        if (showDisk)
            segments.push(panelSegment('DISK', this._disk ? this._disk.percent : null));

        this._label.text = segments.join('  ');
        this.visible = segments.length > 0;

        this._cpuRow.visible = showCpu;
        this._cpuRow.update(null, this._cpu);

        this._memoryRow.visible = showMemory;
        this._memoryRow.update(
            this._memory
                ? `${formatBytes(this._memory.used)} of ${formatBytes(this._memory.total)}`
                : null,
            memoryUsagePercent(this._memory));

        this._diskRow.visible = showDisk;
        this._diskRow.update(
            this._disk
                ? `${formatBytes(this._disk.used)} of ${formatBytes(this._disk.size)} at ${this._disk.path}`
                : null,
            this._disk ? this._disk.percent : null);
    }

    destroy() {
        this._destroyed = true;
        this._diskCancellable.cancel();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        super.destroy();
    }
});

export default class ResourceWatcherExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new Indicator(this, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._intervalChangedId = this._settings.connect(
            'changed::update-interval', () => this._startTimers());
        this._startTimers();
    }

    disable() {
        this._stopTimers();
        if (this._intervalChangedId) {
            this._settings.disconnect(this._intervalChangedId);
            this._intervalChangedId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }

    _startTimers() {
        this._stopTimers();

        const interval = this._settings.get_int('update-interval');
        const intervalMs = Math.min(Math.max(interval, 1), 300) * 1000;

        // One early refresh: CPU usage needs two samples, and waiting a full
        // interval for the first one feels broken on slow intervals.
        if (intervalMs > PRIME_DELAY_MS) {
            this._primeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PRIME_DELAY_MS, () => {
                this._primeId = 0;
                this._indicator?.update();
                return GLib.SOURCE_REMOVE;
            });
        }

        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            this._indicator?.update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimers() {
        if (this._primeId) {
            GLib.Source.remove(this._primeId);
            this._primeId = 0;
        }
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
    }
}

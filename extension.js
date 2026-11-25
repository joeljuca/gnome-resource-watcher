import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CPU_STAT_PATH = '/proc/stat';
const MEMINFO_PATH = '/proc/meminfo';

// Minimum wall-clock gap between two /proc/stat samples for the CPU
// percentage to be meaningful.
const MIN_CPU_SAMPLE_US = 250_000;

// Refresh shortly after enabling so the CPU reading appears without
// waiting a full update interval.
const PRIME_DELAY_MS = 1000;

const WARN_THRESHOLD = 75;
const CRIT_THRESHOLD = 90;

function readTextFile(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

/**
 * Read the aggregate CPU counters from /proc/stat.
 *
 * @returns {{idle: number, total: number, at: number}|null} counters plus
 *   the monotonic timestamp of the sample
 */
function readCpuTimes() {
    const text = readTextFile(CPU_STAT_PATH);
    if (text === null)
        return null;

    const line = text.split('\n')[0] ?? '';
    if (!/^cpu\s/.test(line))
        return null;

    const fields = line.trim().split(/\s+/).slice(1)
        .map(value => Number(value));
    if (fields.length < 4)
        return null;

    let total = 0;
    for (const field of fields)
        total += Number.isFinite(field) ? field : 0;

    const idle = (fields[3] ?? 0) + (fields[4] ?? 0); // idle + iowait
    return {idle, total, at: GLib.get_monotonic_time()};
}

/**
 * @param {{idle: number, total: number, at: number}|null} previous
 * @param {{idle: number, total: number, at: number}|null} current
 * @returns {number|null} CPU usage in percent, or null when the samples
 *   are missing or too close together
 */
function cpuUsage(previous, current) {
    if (!previous || !current)
        return null;
    if (current.at - previous.at < MIN_CPU_SAMPLE_US)
        return null;

    const deltaTotal = current.total - previous.total;
    const deltaIdle = current.idle - previous.idle;
    if (deltaTotal <= 0)
        return null;

    return Math.min(100, Math.max(0, ((deltaTotal - deltaIdle) / deltaTotal) * 100));
}

/**
 * @returns {{total: number, available: number, used: number}|null}
 */
function readMemory() {
    const text = readTextFile(MEMINFO_PATH);
    if (text === null)
        return null;

    const field = key => {
        const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
        return match ? Number(match[1]) * 1024 : null;
    };

    const total = field('MemTotal');
    if (!total)
        return null;

    let available = field('MemAvailable');
    if (available === null) {
        // Kernels without MemAvailable: approximate with the reclaimable
        // caches, like free(1) used to do.
        available = (field('MemFree') ?? 0) + (field('Buffers') ?? 0) +
            (field('Cached') ?? 0);
    }

    return {total, available, used: Math.max(0, total - available)};
}

/**
 * Parse the output of `df -PB1`.
 *
 * @param {string} output
 * @returns {{size: number, used: number, percent: number}|null}
 */
function parseDfOutput(output) {
    if (!output)
        return null;

    const lines = output.trim().split('\n').filter(line => line.trim().length > 0);
    if (lines.length < 2)
        return null;

    // POSIX: <filesystem> <1-blocks> <used> <available> <capacity> <mountpoint>
    const fields = lines[lines.length - 1].trim().split(/\s+/);
    if (fields.length < 4)
        return null;

    const size = Number(fields[1]);
    const used = Number(fields[2]);
    if (!Number.isFinite(size) || !Number.isFinite(used) || size <= 0 || used < 0)
        return null;

    // Prefer df's own capacity figure so the value matches `df` output.
    const capacity = Number.parseInt(fields[4], 10);
    const percent = Number.isFinite(capacity)
        ? Math.min(100, capacity)
        : (used / size) * 100;

    return {size, used, percent};
}

/**
 * Ask df for the usage of the filesystem containing `path`. Runs
 * asynchronously so the shell's main loop is never blocked.
 */
function queryDiskUsage(path, cancellable, callback) {
    let process;
    try {
        process = Gio.Subprocess.new(
            ['df', '-PB1', '--', path],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch {
        callback(null);
        return;
    }

    process.communicate_utf8_async(null, cancellable, (source, result) => {
        try {
            const [, stdout] = source.communicate_utf8_finish(result);
            callback(parseDfOutput(stdout));
        } catch {
            callback(null);
        }
    });
}

function formatBytes(bytes) {
    if (bytes === null || !Number.isFinite(bytes))
        return '—';
    return GLib.format_size_full(bytes, GLib.FormatSizeFlags.IEC_UNITS);
}

function memoryUsagePercent(memory) {
    if (!memory || memory.total <= 0)
        return null;
    return Math.min(100, (memory.used / memory.total) * 100);
}

/**
 * One segment of the panel label, e.g. "CPU  12%".
 * Numbers are padded so the label does not jitter while updating.
 */
function panelSegment(label, percent) {
    if (percent === null || !Number.isFinite(percent))
        return `${label} —`;
    return `${label} ${String(Math.round(percent)).padStart(3)}%`;
}

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

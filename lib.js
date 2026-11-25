// Pure sampling and parsing logic for Resource Watcher.
//
// This module deliberately imports nothing from the GNOME Shell resource
// hierarchy so it can be loaded both by extension.js inside the shell and
// by tests/run.js under plain gjs.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CPU_STAT_PATH = '/proc/stat';
const MEMINFO_PATH = '/proc/meminfo';

// Minimum wall-clock gap between two /proc/stat samples for the CPU
// percentage to be meaningful.
const MIN_CPU_SAMPLE_US = 250_000;

function readTextFile(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

/**
 * Parse the aggregate CPU line of /proc/stat.
 *
 * @param {string|null} text contents of /proc/stat
 * @param {number} at monotonic timestamp of the sample
 * @returns {{idle: number, total: number, at: number}|null}
 */
export function parseCpuStat(text, at) {
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
    return {idle, total, at};
}

/**
 * @returns {{idle: number, total: number, at: number}|null} counters plus
 *   the monotonic timestamp of the sample
 */
export function readCpuTimes() {
    return parseCpuStat(readTextFile(CPU_STAT_PATH), GLib.get_monotonic_time());
}

/**
 * @param {{idle: number, total: number, at: number}|null} previous
 * @param {{idle: number, total: number, at: number}|null} current
 * @returns {number|null} CPU usage in percent, or null when the samples
 *   are missing or too close together
 */
export function cpuUsage(previous, current) {
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
 * @param {string|null} text contents of /proc/meminfo
 * @returns {{total: number, available: number, used: number}|null}
 */
export function parseMeminfo(text) {
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
 * @returns {{total: number, available: number, used: number}|null}
 */
export function readMemory() {
    return parseMeminfo(readTextFile(MEMINFO_PATH));
}

/**
 * Parse the output of `df -PB1`.
 *
 * @param {string} output
 * @returns {{size: number, used: number, percent: number}|null}
 */
export function parseDfOutput(output) {
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
 *
 * callback receives null on failure.
 */
export function queryDiskUsage(path, cancellable, callback) {
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

export function formatBytes(bytes) {
    if (bytes === null || !Number.isFinite(bytes))
        return '—';
    return GLib.format_size_full(bytes, GLib.FormatSizeFlags.IEC_UNITS);
}

export function memoryUsagePercent(memory) {
    if (!memory || memory.total <= 0)
        return null;
    return Math.min(100, (memory.used / memory.total) * 100);
}

/**
 * One segment of the panel label, e.g. "CPU  12%".
 * Numbers are padded so the label does not jitter while updating.
 */
export function panelSegment(label, percent) {
    if (percent === null || !Number.isFinite(percent))
        return `${label} —`;
    return `${label} ${String(Math.round(percent)).padStart(3)}%`;
}

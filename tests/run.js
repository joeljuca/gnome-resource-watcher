// Unit tests for the pure logic in lib.js.
//
// Run with:  gjs -m tests/run.js    (or: make test)
// No GNOME Shell required — only GLib/Gio.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    cpuUsage,
    formatBytes,
    memoryUsagePercent,
    panelSegment,
    parseCpuStat,
    parseDfOutput,
    parseMeminfo,
    readCpuTimes,
    readMemory,
} from '../lib.js';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e)
        passed++;
    else
        failures.push(`${name}: expected ${e}, got ${a}`);
}

// --- /proc/stat parsing -----------------------------------------------------

{
    const text = 'cpu  100 0 50 850 10 5 5 0 0 0\ncpu0 10 0 5 85 0 0 0 0 0 0\n';
    const parsed = parseCpuStat(text, 42);
    check('parseCpuStat total', parsed?.total, 1020);
    check('parseCpuStat idle+iowait', parsed?.idle, 860);
    check('parseCpuStat timestamp', parsed?.at, 42);
    check('parseCpuStat ignores per-core lines', parseCpuStat('cpu0 1 2 3 4\n', 0), null);
    check('parseCpuStat truncated line', parseCpuStat('cpu 1 2\n', 0), null);
    check('parseCpuStat garbage', parseCpuStat('not proc data', 0), null);
    check('parseCpuStat null input', parseCpuStat(null, 0), null);
}

// --- CPU percentage ----------------------------------------------------------

{
    const prev = {idle: 100, total: 1000, at: 0};
    check('cpuUsage half busy', cpuUsage(prev, {idle: 150, total: 1100, at: 1_000_000}), 50);
    check('cpuUsage idle only', cpuUsage(prev, {idle: 200, total: 1100, at: 1_000_000}), 0);
    check('cpuUsage clamps to 100', cpuUsage(prev, {idle: 50, total: 1100, at: 1_000_000}), 100);
    check('cpuUsage needs sample gap', cpuUsage(prev, {idle: 150, total: 1100, at: 100}), null);
    check('cpuUsage needs a delta', cpuUsage(prev, {idle: 100, total: 1000, at: 1_000_000}), null);
    check('cpuUsage missing previous', cpuUsage(null, prev), null);
    check('cpuUsage missing current', cpuUsage(prev, null), null);
}

// --- /proc/meminfo parsing ---------------------------------------------------

{
    const text = [
        'MemTotal:       16384000 kB',
        'MemFree:         2048000 kB',
        'MemAvailable:    8192000 kB',
        'Buffers:          512000 kB',
        'Cached:          4096000 kB',
        '',
    ].join('\n');
    const parsed = parseMeminfo(text);
    check('parseMeminfo total', parsed?.total, 16384000 * 1024);
    check('parseMeminfo available', parsed?.available, 8192000 * 1024);
    check('parseMeminfo used', parsed?.used, (16384000 - 8192000) * 1024);

    // Old kernels: no MemAvailable, fall back to free + buffers + cached.
    const legacy = text.replace('MemAvailable:    8192000 kB\n', '');
    check('parseMeminfo legacy fallback',
        parseMeminfo(legacy)?.available,
        (2048000 + 512000 + 4096000) * 1024);

    check('parseMeminfo empty', parseMeminfo(''), null);
    check('parseMeminfo null', parseMeminfo(null), null);
}

// --- df output parsing -------------------------------------------------------

{
    const df = [
        'Filesystem     1-blocks       Used  Available Capacity Mounted on',
        '/dev/sda1   495253979136 321561448448 171189612544      66% /',
        '',
    ].join('\n');
    const parsed = parseDfOutput(df);
    check('parseDfOutput size', parsed?.size, 495253979136);
    check('parseDfOutput used', parsed?.used, 321561448448);
    check('parseDfOutput percent from capacity', parsed?.percent, 66);

    // df error output (bad path): one line, no numbers -> null.
    check('parseDfOutput error output',
        parseDfOutput('df: /nonexistent: No such file or directory\n'), null);
    check('parseDfOutput empty', parseDfOutput(''), null);
    check('parseDfOutput header only', parseDfOutput('Filesystem 1-blocks Used\n'), null);

    // No capacity column: fall back to used / size.
    const noCapacity = 'Filesystem 1-blocks Used Available Mounted on\nfs 1000 250 750 /\n';
    check('parseDfOutput fallback percent', parseDfOutput(noCapacity)?.percent, 25);

    // Non-numeric columns -> null instead of NaN.
    const bogus = 'Filesystem 1-blocks Used Available Capacity Mounted on\nfs a b c d%\n';
    check('parseDfOutput non-numeric', parseDfOutput(bogus), null);
}

// --- label formatting --------------------------------------------------------

{
    check('panelSegment null', panelSegment('CPU', null), 'CPU —');
    check('panelSegment NaN', panelSegment('RAM', NaN), 'RAM —');
    check('panelSegment pads two digits', panelSegment('CPU', 12.4), 'CPU  12%');
    check('panelSegment pads one digit', panelSegment('CPU', 5), 'CPU   5%');
    check('panelSegment three digits', panelSegment('DISK', 100), 'DISK 100%');
}

{
    check('memoryUsagePercent', memoryUsagePercent({total: 200, used: 100, available: 100}), 50);
    check('memoryUsagePercent null', memoryUsagePercent(null), null);
    check('memoryUsagePercent zero total', memoryUsagePercent({total: 0, used: 0, available: 0}), null);
    // format_size_full inserts a non-breaking space before the unit.
    check('formatBytes iec', formatBytes(1610612736).replace(/\u00a0/g, ' '), '1.5 GiB');
    check('formatBytes null', formatBytes(null), '—');
}

// --- GSettings schema --------------------------------------------------------
// Regression: the interval key must be 'i' — extension.js and prefs.js read it
// with get_int(), which produces GLib criticals on a 'u' key.

{
    const here = GLib.path_get_dirname(
        decodeURIComponent(import.meta.url.replace(/^file:\/\//, '')));
    const schemaDir = GLib.build_filenamev([GLib.path_get_dirname(here), 'schemas']);
    const source = Gio.SettingsSchemaSource.new_from_directory(
        schemaDir, Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup('org.gnome.shell.extensions.resource-watcher', false);

    check('schema found', schema !== null, true);
    if (schema) {
        const typeOf = key => schema.get_key(key).get_value_type().dup_string();
        check('update-interval key type', typeOf('update-interval'), 'i');
        check('show-cpu key type', typeOf('show-cpu'), 'b');
        check('show-ram key type', typeOf('show-ram'), 'b');
        check('show-disk key type', typeOf('show-disk'), 'b');
        check('disk-path key type', typeOf('disk-path'), 's');
        check('update-interval default',
            schema.get_key('update-interval').get_default_value().get_int32(), 2);
        check('disk-path default',
            schema.get_key('disk-path').get_default_value().get_string()[0], '/');
    }
}

// --- live /proc smoke test ---------------------------------------------------

{
    const cpu = readCpuTimes();
    check('live cpu sample sane', cpu !== null && cpu.total > 0, true);
    const memory = readMemory();
    check('live memory sample sane', memory !== null && memory.total > 0, true);
}

// -----------------------------------------------------------------------------

if (failures.length > 0) {
    for (const failure of failures)
        print(`FAIL ${failure}`);
    throw new Error(`${failures.length} of ${passed + failures.length} checks failed`);
}
print(`OK: ${passed} checks passed`);

// Run the unit tests with node's built-in runner — no dependencies.
//
// The files are listed explicitly rather than passed as a glob. A glob that matches nothing
// (cmd.exe does not expand them; a typo; a moved folder) makes `node --test` run ZERO tests and
// exit 0, which reads exactly like a green build. That happened while this harness was being
// written: every deliberately re-introduced bug "passed". So: list the files, refuse to run
// with none, and refuse to report success if the runner ran nothing.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'apps', 'web', 'test');
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => join(dir, f));
if (!files.length) { console.error(`no *.test.js files in ${dir}`); process.exit(1); }

const r = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8' });
process.stdout.write(r.stdout); process.stderr.write(r.stderr);
const ran = /^ℹ tests (\d+)/m.exec(r.stdout);
if (!ran || +ran[1] === 0) { console.error('the test runner ran no tests'); process.exit(1); }
process.exit(r.status ?? 1);

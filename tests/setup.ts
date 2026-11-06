import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-tests-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = path.join(home, '.config');
process.env.XDG_CACHE_HOME = path.join(home, '.cache');
assert.equal(os.homedir(), home, 'Tests must not use the real plugin cache');

process.once('exit', () => fs.rmSync(home, { recursive: true, force: true }));

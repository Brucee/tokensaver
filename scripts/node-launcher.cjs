'use strict';
// tokenSaver node launcher — ES5, core modules only.
// Used by the generated .cjs stubs to re-exec the real .mjs target under a
// supported Node when the spawning interpreter is too old, and to cache the
// discovered runtime so repeated hook invocations stay cheap.

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var C = require('./node-launcher-constants.cjs');

var VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(-\S*)?/;
var PROBE_TIMEOUT_MS = 5000;

function parseVersion(value) {
  var m = VERSION_PATTERN.exec(String(value).trim());
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : 0];
}

function compareVersions(a, b) {
  for (var i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function isSupported(value) {
  var v = parseVersion(value);
  var min = parseVersion(C.MIN_NODE_VERSION);
  return v !== undefined && min !== undefined && compareVersions(v, min) >= 0;
}

function exists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

function readJson(p) {
  try {
    var o = JSON.parse(fs.readFileSync(p, 'utf8'));
    return o !== null && typeof o === 'object' ? o : undefined;
  } catch (e) { return undefined; }
}

function configDir() {
  var base = process.env[C.CONFIG_DIR_ENV_VAR] || path.join(os.homedir(), C.CLAUDE_HOME_DIR_NAME);
  return path.join(base, C.CONFIG_SUBDIR_NAME);
}

function dataDir() {
  return process.env[C.DATA_DIR_ENV_VAR] || path.join(os.homedir(), C.CLAUDE_HOME_DIR_NAME, C.DATA_DIR_NAME);
}

function probeVersion(nodePath) {
  try {
    var out = childProcess.execFileSync(nodePath, ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out).trim();
  } catch (e) {
    return undefined;
  }
}

function findInPath() {
  var envPath = process.env.PATH || '';
  var sep = process.platform === 'win32' ? ';' : ':';
  var names = process.platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node'];
  var dirs = envPath.split(sep);
  for (var i = 0; i < dirs.length; i++) {
    for (var j = 0; j < names.length; j++) {
      var p = path.join(dirs[i], names[j]);
      if (exists(p)) return p;
    }
  }
  return undefined;
}

function versionManagerCandidates() {
  var home = os.homedir();
  var out = [];
  var dirs = [
    path.join(home, '.nvm', 'versions', 'node'),
    path.join(home, '.volta', 'tools', 'image', 'node'),
    path.join(home, '.asdf', 'installs', 'nodejs'),
    path.join(home, '.fnm', 'node-versions'),
    path.join(home, 'AppData', 'Local', 'fnm_multishells'),
    path.join(home, 'AppData', 'Roaming', 'nvm'),
    'C:\\Program Files\\nodejs',
  ];
  for (var i = 0; i < dirs.length; i++) {
    var entries = fs.existsSync(dirs[i]) ? fs.readdirSync(dirs[i]) : [];
    for (var j = 0; j < entries.length; j++) {
      out.push(path.join(dirs[i], entries[j], 'bin', 'node'));
      out.push(path.join(dirs[i], entries[j], 'node.exe'));
    }
    out.push(path.join(dirs[i], 'node.exe'));
    out.push(path.join(dirs[i], 'node'));
  }
  return out;
}

function markFailure() {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(path.join(configDir(), C.FAILURE_FILENAME), JSON.stringify({ at: Date.now() }));
  } catch (e) {}
}

function failedRecently() {
  var marker = readJson(path.join(configDir(), C.FAILURE_FILENAME));
  return marker && typeof marker.at === 'number' && Date.now() - marker.at < C.FAILURE_TTL_MS;
}

function cacheNode(nodePath) {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(path.join(configDir(), C.CACHE_FILENAME), JSON.stringify({ node: nodePath, at: Date.now() }));
  } catch (e) {}
}

function discoverNode() {
  // 1. explicit env override
  var envNode = process.env[C.NODE_ENV_VAR];
  if (envNode && exists(envNode) && isSupported(probeVersion(envNode))) {
    return envNode;
  }
  // 2. cached discovery
  var cache = readJson(path.join(configDir(), C.CACHE_FILENAME));
  if (cache && cache.node && exists(cache.node) && isSupported(probeVersion(cache.node))) {
    return cache.node;
  }
  if (failedRecently()) return undefined;
  // 3. current interpreter
  if (isSupported(process.version)) return process.execPath;
  // 4. PATH
  var inPath = findInPath();
  if (inPath && isSupported(probeVersion(inPath))) {
    cacheNode(inPath);
    return inPath;
  }
  // 5. version managers / common install dirs
  var candidates = versionManagerCandidates();
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (exists(c) && isSupported(probeVersion(c))) {
      cacheNode(c);
      return c;
    }
  }
  markFailure();
  return undefined;
}

function tooOldMessage() {
  return C.TOO_OLD_MESSAGE_TEMPLATE
    .replace('{min}', C.MIN_NODE_VERSION)
    .replace('{found}', process.version) + ' ' + C.VERSION_MANAGER_HINT;
}

// Re-exec `targetAbs` under a supported node if the current interpreter is
// too old; otherwise just require/import it. `stdio` is inherited.
function launch(targetAbs, role) {
  if (isSupported(process.version)) {
    return; // caller proceeds with import()
  }
  if (process.env[C.REEXEC_ENV_VAR]) {
    // Already re-execed once; don't loop.
    process.stderr.write(tooOldMessage() + '\n');
    process.exit(0);
  }
  var node = discoverNode();
  if (!node) {
    process.stderr.write(tooOldMessage() + '\n');
    process.exit(0);
  }
  var env = {};
  for (var k in process.env) env[k] = process.env[k];
  env[C.REEXEC_ENV_VAR] = '1';
  env[C.NODE_ENV_VAR] = node;
  env[C.SOURCE_ENV_VAR] = role || 'launcher';
  var result = childProcess.spawnSync(node, ['--no-warnings=ExperimentalWarning', targetAbs], {
    stdio: 'inherit',
    env: env,
  });
  if (result.signal) {
    try { process.kill(process.pid, result.signal); } catch (e) {}
  }
  process.exit(result.status == null ? 0 : result.status);
}

module.exports = { launch: launch, isSupported: isSupported, discoverNode: discoverNode };

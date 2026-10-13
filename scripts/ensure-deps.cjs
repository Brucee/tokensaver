#!/usr/bin/env node
// MCP server bootstrap: plugin installs don't run npm install, so on first
// load we install production deps ourselves, then hand off to the server.
// npm output goes to stderr — stdout is the MCP protocol channel.
var fs = require('fs');
var path = require('path');
var url = require('url');
var cp = require('child_process');

var root = path.resolve(__dirname, '..');
require('./node-launcher.cjs').launch(__filename, 'server');
var manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
var lock;
try { lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')); } catch (e) {}
function dependenciesPresent() {
  return Object.keys(manifest.dependencies || {}).every(function (name) {
    try {
      var installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
      var locked = lock && lock.packages && lock.packages['node_modules/' + name];
      return !locked || installed.version === locked.version;
    } catch (e) { return false; }
  });
}

if (!dependenciesPresent()) {
  var npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  process.stderr.write('tokensaver: installing dependencies (first run, one time only)...\n');
  // Windows: npm is a .cmd shim — spawning it without a shell is EINVAL on Node ≥ 20.12.
  var res = cp.spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
  try { lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')); } catch (e) {}
  if (res.status !== 0 || !dependenciesPresent()) {
    process.stderr.write('tokensaver: dependency install failed — run `npm install --omit=dev` inside ' + root + '\n');
    process.exit(1);
  }
}

import(url.pathToFileURL(path.join(root, 'servers', 'code-server.mjs')).href);

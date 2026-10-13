'use strict';
// Session hook entrypoint — re-exec under a supported Node if needed,
// then load the real implementation.
var path = require('path');
var url = require('url');
var launcher = require('./node-launcher.cjs');

var target = path.join(__dirname, '..', 'src', 'hooks', 'session-hook.mjs');
launcher.launch(target, 'session-hook');
import(url.pathToFileURL(target).href);

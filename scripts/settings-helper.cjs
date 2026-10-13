'use strict';
var path = require('path');
var url = require('url');
var launcher = require('./node-launcher.cjs');

var target = path.join(__dirname, '..', 'src', 'cli', 'settings-helper.mjs');
launcher.launch(target, 'settings-helper');
import(url.pathToFileURL(target).href);

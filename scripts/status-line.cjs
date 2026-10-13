'use strict';
var path = require('path');
var url = require('url');
var launcher = require('./node-launcher.cjs');

var target = path.join(__dirname, '..', 'src', 'hooks', 'status-line.mjs');
launcher.launch(target, 'status-line');
import(url.pathToFileURL(target).href);

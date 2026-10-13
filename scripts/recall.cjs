'use strict';
// Recall CLI entrypoint — re-exec under a supported Node if needed,
// then load the real implementation.
var path = require('path');
var url = require('url');
var launcher = require('./node-launcher.cjs');

var target = path.join(__dirname, '..', 'src', 'cli', 'recall.mjs');
launcher.launch(target, 'recall');
import(url.pathToFileURL(target).href).then(function (m) {
  return m.runMain();
}).catch(function (e) {
  console.error('Recall failed: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});

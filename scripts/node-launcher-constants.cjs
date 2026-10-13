'use strict';
// Constants shared by node-launcher.cjs. ES5 only.
module.exports = {
  MIN_NODE_VERSION: '22.16.0',
  NODE_ENV_VAR: 'TOKENSAVER_NODE',
  SOURCE_ENV_VAR: 'TOKENSAVER_NODE_SOURCE',
  REEXEC_ENV_VAR: 'TOKENSAVER_REEXEC',
  CONFIG_DIR_ENV_VAR: 'CLAUDE_CONFIG_DIR',
  CLAUDE_HOME_DIR_NAME: '.claude',
  CONFIG_SUBDIR_NAME: 'tokensaver',
  DATA_DIR_ENV_VAR: 'TOKENSAVER_HOME',
  DATA_DIR_NAME: 'tokensaver',
  CACHE_FILENAME: 'node-runtime-cache.json',
  FAILURE_FILENAME: 'node-discovery-failed.json',
  FAILURE_TTL_MS: 6 * 60 * 60 * 1000,
  TOO_OLD_MESSAGE_TEMPLATE:
    'tokenSaver requires Node.js {min} or newer (found {found}). ' +
    'Install a current Node.js or point ' + 'TOKENSAVER_NODE' + ' at one.',
  VERSION_MANAGER_HINT:
    'If you use nvm/fnm/volta/asdf, run your Node version manager inside this shell first, or set TOKENSAVER_NODE to an absolute node binary path.',
};

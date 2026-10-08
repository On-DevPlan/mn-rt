'use strict';

/**
 * 模块导出：把内部能力暴露出来，便于单元测试与二次开发。
 */

const { AgentManager, STATE } = require('./agent');
const { MessageQueue } = require('./queue');
const { ServeClient } = require('./ws-client');
const { LocalStore } = require('./store');
const { Logger } = require('./logger');
const sanitize = require('./sanitize');
const platform = require('./platform');
const config = require('./config');

module.exports = {
  AgentManager,
  STATE,
  MessageQueue,
  ServeClient,
  LocalStore,
  Logger,
  sanitize,
  platform,
  config,
  version: require('../package.json').version,
};

'use strict';

const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] || LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const rec = Object.assign(
    { ts: new Date().toISOString(), level, msg },
    fields || {}
  );
  const line = JSON.stringify(rec);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

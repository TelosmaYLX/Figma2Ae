'use strict';

const {ensureRelay} = require('../launcher.cjs');
let selectedSession = null;

async function request(route, body, signal) {
  await new Promise((resolve, reject) => ensureRelay(error => error ? reject(error) : resolve()));
  const response = await fetch('http://127.0.0.1:' + (process.env.F2A_MCP_PORT || 7367) + route, body === undefined ? {} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error);
    error.nodeId = result.nodeId;
    throw error;
  }
  return result;
}

async function status() { return request('/sessions'); }
async function selectSession(id = '') {
  const {sessions} = await status();
  if (!sessions.length) throw new Error('请在 Figma 文档中打开 F2A');
  if (!id || id === 'f2a') {
    if (sessions.length !== 1) throw new Error('已打开多个 F2A 文档，请用 get_f2a_status 查看，再用 join_channel 选择文档 ID');
    selectedSession = sessions[0].id;
  } else {
    const matches = sessions.filter(session => session.id === id || session.fileKey === id || session.name === id);
    if (matches.length !== 1) throw new Error('文档不存在或名称重复，请用 get_f2a_status 查看文档 ID');
    selectedSession = matches[0].id;
  }
  return sessions.find(session => session.id === selectedSession);
}

async function sendCommandToFigma(command, params = {}, signal) {
  if (!selectedSession) await selectSession();
  // An explicitly selected session remains pinned even if it closes. Never silently retarget edits.
  const {result} = await request('/command', {sessionId:selectedSession, command, params}, signal);
  return result;
}

module.exports = {status, selectSession, sendCommandToFigma};

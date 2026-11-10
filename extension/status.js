'use strict';

const byId = id => document.getElementById(id);
let nameInitialized = false;
let sessionSignature = '';
let refreshing = false;

async function rpc(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || result.error)
    throw new Error('扩展暂不可用');
  return result;
}

function render(state) {
  byId('connection').textContent = state.message;
  byId('connection').dataset.state = state.state;
  byId('browser').textContent = state.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome';
  byId('profileId').textContent = state.profileId;
  if (!nameInitialized) {
    byId('profileName').value = state.profileName;
    nameInitialized = true;
  }
  byId('empty').hidden = state.sessions.length > 0;
  const signature = JSON.stringify(state.sessions);
  if (signature === sessionSignature)
    return;
  sessionSignature = signature;
  byId('sessions').replaceChildren();
  for (const session of state.sessions) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = session.title;
    const detail = document.createElement('p');
    detail.textContent = `${session.state === 'connected' ? '已连接' : '正在连接'} · tabId：${session.tabIds.join(', ') || '创建中'}`;
    const id = document.createElement('p');
    id.className = 'muted';
    id.textContent = `会话 ${session.id}`;
    const disconnect = document.createElement('button');
    disconnect.type = 'button';
    disconnect.textContent = '断开会话';
    disconnect.addEventListener('click', async () => {
      disconnect.disabled = true;
      try {
        render(await rpc({ type: 'disconnect', id: session.id }));
        byId('feedback').textContent = '会话已断开，网页已保留。';
      } catch {
        byId('feedback').textContent = '断开失败，请重试。';
        disconnect.disabled = false;
      }
    });
    item.append(title, detail, id, disconnect);
    byId('sessions').append(item);
  }
}

async function refresh() {
  if (refreshing)
    return;
  refreshing = true;
  try {
    render(await rpc({ type: 'getStatus' }));
  } catch {
    byId('connection').textContent = '无法读取扩展状态，请在扩展管理页重新加载。';
    byId('connection').dataset.state = 'error';
  } finally {
    refreshing = false;
  }
}

byId('profileForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const state = await rpc({ type: 'setProfileName', name: byId('profileName').value });
    byId('profileName').value = state.profileName;
    render(state);
    byId('feedback').textContent = '名称已保存，下次连接生效。';
  } catch {
    byId('feedback').textContent = '保存失败，请重试。';
  } finally {
    button.disabled = false;
  }
});
byId('reconnect').addEventListener('click', async () => {
  if (byId('sessions').children.length && !confirm('重新连接会断开全部 Agent 会话，但不会关闭网页。继续吗？'))
    return;
  byId('reconnect').disabled = true;
  try {
    render(await rpc({ type: 'reconnect' }));
    byId('feedback').textContent = '正在重新连接本地桥接。';
  } catch {
    byId('feedback').textContent = '重连失败，请在扩展管理页重新加载。';
  } finally {
    byId('reconnect').disabled = false;
  }
});
void refresh();
const timer = setInterval(refresh, 1000);
window.addEventListener('pagehide', () => clearInterval(timer), { once: true });

import { RelayConnection } from './upstream/relayConnection';
import { ConnectedTabGroup, uniqueGroupStyle, type GroupStyle } from './upstream/connectedTabGroup';

type Pairing = { port: number; token: string };
type Session = {
  id: string;
  clientName: string;
  style: GroupStyle;
  tabId?: number;
  socket?: WebSocket;
  connection?: RelayConnection;
  group?: ConnectedTabGroup;
  accepted: boolean;
  cancelled: boolean;
};

const browser = /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
const sessions = new Map<string, Session>();
const ALARM = 'bridge-reconnect';
let profileId = '';
let profileName = '';
let control: WebSocket | undefined;
let connecting = false;
let authenticated = false;
let connectionState = 'starting';
let statusMessage = '正在初始化';
let retryAttempt = 0;
let retryAt = 0;
let generation = 0;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let helloTimeout: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function status(state: string, message: string): void {
  connectionState = state;
  statusMessage = message;
  // Only fixed UI strings are used here; never log errors, URLs, CDP or credentials.
  void chrome.action.setBadgeText({ text: state === 'connected' ? 'ON' : '!' }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ color: state === 'connected' ? '#26854b' : '#b56a16' }).catch(() => {});
  void chrome.action.setTitle({ title: `Agent 浏览器桥接：${message}` }).catch(() => {});
}

function send(socket: WebSocket | undefined, message: object): boolean {
  if (socket?.readyState !== WebSocket.OPEN)
    return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function stopSession(session: Session): void {
  session.cancelled = true;
  if (sessions.get(session.id) === session)
    sessions.delete(session.id);
  session.group?.close('Session disconnected');
  if (!session.group)
    session.connection?.close('Session disconnected');
  session.socket?.close(1000, 'Session disconnected');
  // Deliberately do not remove tabs: pages and their current content remain with the user.
}

function closeControl(): void {
  ++generation;
  clearInterval(heartbeat);
  clearTimeout(helloTimeout);
  heartbeat = undefined;
  helloTimeout = undefined;
  authenticated = false;
  connecting = false;
  const socket = control;
  control = undefined;
  socket?.close(1000, 'Control disconnected');
  for (const session of [...sessions.values()])
    stopSession(session);
}

function scheduleReconnect(): void {
  if (retryTimer)
    return;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(retryAttempt++, 5));
  retryAt = Date.now() + delay;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void connect();
  }, delay);
}

function lostControl(socket: WebSocket): void {
  if (control !== socket)
    return;
  closeControl();
  status('disconnected', '本地桥接已断开，正在自动重连');
  scheduleReconnect();
}

// Error, early close and timeout all close the socket and remove temporary listeners.
function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
      socket.removeEventListener('close', failed);
      if (ok) {
        resolve();
      } else {
        socket.close();
        reject(new Error('本地连接失败或超时'));
      }
    };
    const opened = () => finish(true);
    const failed = () => finish(false);
    const timer = setTimeout(failed, 10_000);
    socket.addEventListener('open', opened);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', failed);
  });
}

async function readPairing(): Promise<Pairing> {
  const response = await fetch(chrome.runtime.getURL('pairing.json'), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok)
    throw new Error('配对文件不可用');
  const pairing = await response.json();
  if (!Number.isInteger(pairing.port) || pairing.port < 1 || pairing.port > 65535 || typeof pairing.token !== 'string' || !pairing.token)
    throw new Error('配对文件无效');
  return pairing;
}

function sessionUrl(value: unknown, port: number): string {
  if (typeof value !== 'string')
    throw new Error('会话地址无效');
  const url = new URL(value);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== String(port) || !/^\/extension\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash || url.username || url.password)
    throw new Error('会话地址无效');
  return url.href;
}

async function startSession(message: any, socket: WebSocket, port: number): Promise<void> {
  const id = message.id;
  if (typeof id !== 'string' || !id || id.length > 200)
    return;
  if (sessions.has(id)) {
    send(socket, { type: 'sessionError', id, error: '会话编号已存在' });
    return;
  }
  let extensionUrl: string;
  try {
    extensionUrl = sessionUrl(message.extensionUrl, port);
  } catch {
    send(socket, { type: 'sessionError', id, error: '会话地址无效' });
    return;
  }
  const clientName = typeof message.clientName === 'string' ? message.clientName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : 'Agent';
  const session: Session = {
    id, clientName,
    style: uniqueGroupStyle(clientName, [...sessions.values()].map(item => item.style)),
    accepted: false, cancelled: false,
  };
  sessions.set(id, session);
  try {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    session.tabId = tab.id;
    if (session.cancelled || control !== socket || !authenticated)
      throw new Error('会话已取消');
    session.socket = new WebSocket(extensionUrl);
    await waitForOpen(session.socket);
    if (session.cancelled || control !== socket)
      throw new Error('会话已取消');
    const connection = session.connection = new RelayConnection(session.socket);
    const group = session.group = new ConnectedTabGroup(connection, tab, clientName, session.style, tabId => {
      return RelayConnection.isReserved(tabId, connection) || [...sessions.values()].some(other => other !== session && other.tabId === tabId);
    });
    group.onclose = () => {
      const wasAccepted = session.accepted;
      session.cancelled = true;
      if (sessions.get(id) === session)
        sessions.delete(id);
      if (wasAccepted)
        send(socket, { type: 'sessionClosed', id });
    };
    await group.ready;
    if (session.cancelled || control !== socket || session.socket.readyState !== WebSocket.OPEN)
      throw new Error('会话已取消');
    session.accepted = true;
    send(socket, { type: 'sessionAccepted', id });
  } catch {
    stopSession(session);
    statusMessage = '会话连接失败；请检查本地桥接与浏览器调试权限';
    send(socket, { type: 'sessionError', id, error: '无法建立后台标签页会话，请检查本地桥接与调试权限' });
  }
}

async function handleControl(data: unknown, socket: WebSocket, port: number): Promise<void> {
  if (control !== socket || typeof data !== 'string')
    return;
  let message: any;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object')
    return;
  if (message.type === 'hello') {
    if (message.ok !== true) {
      lostControl(socket);
      return;
    }
    clearTimeout(helloTimeout);
    authenticated = true;
    retryAttempt = 0;
    retryAt = 0;
    status('connected', '已连接本地桥接');
  } else if (authenticated && message.type === 'session') {
    await startSession(message, socket, port);
  } else if (authenticated && ['disconnect', 'sessionClosed', 'sessionDisconnect'].includes(message.type)) {
    const session = sessions.get(message.id);
    if (session)
      stopSession(session);
  }
}

async function connect(): Promise<void> {
  await identityReady;
  if (connecting || control)
    return;
  connecting = true;
  const attempt = ++generation;
  status('connecting', '正在连接本地桥接');
  try {
    const pairing = await readPairing();
    if (attempt !== generation)
      return;
    const socket = new WebSocket(`ws://127.0.0.1:${pairing.port}/control`);
    control = socket;
    socket.addEventListener('close', () => lostControl(socket));
    socket.addEventListener('error', () => lostControl(socket));
    socket.addEventListener('message', event => {
      void handleControl(event.data, socket, pairing.port).catch(() => {
        statusMessage = '无法处理本地桥接消息';
      });
    });
    await waitForOpen(socket);
    if (control !== socket || attempt !== generation) {
      socket.close();
      return;
    }
    connecting = false;
    if (!send(socket, { type: 'hello', token: pairing.token, browser, profileId, profileName })) {
      lostControl(socket);
      return;
    }
    helloTimeout = setTimeout(() => lostControl(socket), 10_000);
    heartbeat = setInterval(() => {
      // Application-level traffic keeps the MV3 worker alive without a foreground tab.
      if (!send(socket, { type: 'ping' }))
        lostControl(socket);
    }, 20_000);
  } catch {
    if (attempt !== generation)
      return;
    closeControl();
    status('disconnected', '无法连接本地桥接；请确认桥接已启动且扩展已配对');
    scheduleReconnect();
  }
}

function snapshot() {
  return {
    state: connectionState, message: statusMessage, browser, profileId, profileName,
    retryAt,
    sessions: [...sessions.values()].map(session => ({
      id: session.id, clientName: session.clientName, title: session.style.title,
      state: session.accepted ? 'connected' : 'connecting',
      tabIds: session.group?.connectedTabIds() ?? (session.tabId === undefined ? [] : [session.tabId]),
    })),
  };
}

async function request(message: any): Promise<unknown> {
  await identityReady;
  switch (message?.type) {
    case 'getStatus': return snapshot();
    case 'disconnect': {
      const session = sessions.get(message.id);
      if (session) {
        stopSession(session);
        if (!session.group)
          send(control, { type: 'sessionClosed', id: session.id });
      }
      return snapshot();
    }
    case 'reconnect':
      clearTimeout(retryTimer);
      retryTimer = undefined;
      retryAttempt = 0;
      closeControl();
      void connect();
      return snapshot();
    case 'setProfileName': {
      if (typeof message.name !== 'string')
        throw new Error('名称无效');
      const name = message.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || profileId.slice(0, 8);
      await chrome.storage.local.set({ profileName: name });
      profileName = name;
      return snapshot();
    }
    default: throw new Error('未知操作');
  }
}

const identityReady = (async () => {
  const stored = await chrome.storage.local.get(['profileId', 'profileName']);
  profileId = typeof stored.profileId === 'string' && stored.profileId ? stored.profileId : crypto.randomUUID();
  profileName = typeof stored.profileName === 'string' && stored.profileName.trim() ? stored.profileName.slice(0, 80) : profileId.slice(0, 8);
  await chrome.storage.local.set({ profileId, profileName });
})();

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id)
    return false;
  void request(message).then(respond, () => respond({ error: '操作失败，请检查扩展状态' }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM && !control && !connecting && Date.now() >= retryAt) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    void connect().catch(() => status('error', '扩展初始化失败，请重新加载扩展'));
  }
});
self.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  status('error', '扩展发生异常，请重新连接或重新加载扩展');
});
self.addEventListener('error', event => {
  event.preventDefault();
  status('error', '扩展发生异常，请重新连接或重新加载扩展');
});
void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
void connect().catch(() => status('error', '扩展初始化失败，请重新加载扩展'));

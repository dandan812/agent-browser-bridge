/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export function debugLog(...args: unknown[]): void {
  const enabled = false;
  if (enabled) {
    // eslint-disable-next-line no-console
    console.log('[Extension]', ...args);
  }
}

type ProtocolCommand = {
  id: number;
  method: string;
  params?: any;
};

type ProtocolResponse = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
};

// Allow-listed chrome.* commands the relay may invoke. They are resolved
// reflectively and the positional params are spread into the call.
const ALLOWED_CHROME_COMMANDS = new Set([
  'chrome.debugger.attach',
  'chrome.debugger.detach',
  'chrome.debugger.sendCommand',
  'chrome.tabs.create',
  'chrome.tabs.remove',
]);

// chrome.* events the extension forwards to the relay (positional params).
const CHROME_EVENT_METHODS = [
  'chrome.debugger.onEvent',
  'chrome.debugger.onDetach',
  'chrome.tabs.onCreated',
  'chrome.tabs.onRemoved',
];

const REATTACH_DELAY_MS = 150;
const REATTACH_VERIFY_MS = 2500;
const REATTACH_COOLDOWN_MS = 3000;

export class RelayConnection {
  // Local adaptation: reserve tabs before asynchronous debugger attach, across all sessions.
  private static _owners = new Map<number, RelayConnection>();
  private _eligibleTabs = new Set<number>();

  static isReserved(tabId: number, except?: RelayConnection): boolean {
    const owner = RelayConnection._owners.get(tabId);
    return owner !== undefined && owner !== except;
  }

  ownsTab(tabId: number): boolean {
    return RelayConnection._owners.get(tabId) === this;
  }

  private _reserveTab(tabId: number): boolean {
    if (this._closed || RelayConnection.isReserved(tabId, this))
      return false;
    RelayConnection._owners.set(tabId, this);
    this._eligibleTabs.add(tabId);
    return true;
  }
  private _ws: WebSocket;
  // Tabs whose debugger we have explicitly attached for this connection.
  private _attachedTabs = new Set<number>();
  private _eventListeners: Array<{ remove: () => void }> = [];
  private _closed = false;
  private _pendingReattach = new Set<number>();
  private _recentReattach = new Set<number>();
  private _pendingOperations = new Set<Promise<unknown>>();

  private _track<T>(operation: Promise<T>): Promise<T> {
    this._pendingOperations.add(operation);
    void operation.then(() => this._pendingOperations.delete(operation), () => this._pendingOperations.delete(operation));
    return operation;
  }

  onclose?: () => void;
  ontabattached?: (tabId: number) => void;
  ontabdetached?: (tabId: number) => void;

  get attachedTabs(): ReadonlySet<number> {
    return this._attachedTabs;
  }

  constructor(ws: WebSocket) {
    this._ws = ws;
    this._installEventForwarders();
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => this._onClose();
    this._ws.onerror = () => this.close('Relay socket error');
  }

  // Signals the end of the initial-tab handshake — call after the initial
  // round of `attachTab` invocations. The relay holds CDP traffic from
  // Playwright until it sees this event, so that `Target.setAutoAttach` is
  // answered from a populated tab model.
  didInitialize(): void {
    this._sendMessage({ method: 'extension.initialized', params: [] });
  }

  close(message: string): void {
    try {
      this._ws.close(1000, message);
    } finally {
      // Stop forwarding synchronously, including on WebSocket errors.
      this._onClose();
    }
  }

  // Called when the UI adds a tab to the Playwright group, whether as the
  // initial pick from the connect page or from a later drag-in. Simulates a
  // "new tab opened" event; the relay responds by calling
  // chrome.debugger.attach, which flows through _handleCommand and fires
  // ontabattached.
  attachTab(tab: chrome.tabs.Tab): void {
    if (tab.id === undefined || this._closed || this._attachedTabs.has(tab.id) || !this._reserveTab(tab.id))
      return;
    this._sendMessage({ method: 'chrome.tabs.onCreated', params: [tab] });
  }

  // Called when the UI removes a tab from the Playwright group. We detach the
  // debugger and update bookkeeping. chrome.debugger.detach does not fire
  // onDetach for the caller, so we synthesize one so the relay notices the
  // tab is gone.
  detachTab(tabId: number): void {
    if (this._closed || !this._attachedTabs.has(tabId))
      return;
    void this._track(detachDebugger(tabId));
    this._notifyTabDetached(tabId);
    this._sendMessage({
      method: 'chrome.debugger.onDetach',
      params: [{ tabId }, 'target_closed'],
    });
  }

  private _notifyTabAttached(tabId: number): void {
    this._attachedTabs.add(tabId);
    this._pendingReattach.delete(tabId);
    this.ontabattached?.(tabId);
  }

  private _notifyTabDetached(tabId: number): void {
    this._attachedTabs.delete(tabId);
    this.ontabdetached?.(tabId);
  }

  private _installEventForwarders(): void {
    for (const fullMethod of CHROME_EVENT_METHODS) {
      const target = resolveChromeMember(fullMethod);
      const listener = (...args: any[]) => this._onChromeEvent(fullMethod, args);
      target.obj[target.name].addListener(listener);
      this._eventListeners.push({
        remove: () => target.obj[target.name].removeListener(listener),
      });
    }
  }

  private _onClose() {
    if (this._closed)
      return;
    this._closed = true;
    this._pendingReattach.clear();
    this._recentReattach.clear();
    for (const l of this._eventListeners)
      l.remove();
    this._eventListeners = [];
    const detaches = [...this._attachedTabs].map(tabId => {
      const detached = detachDebugger(tabId);
      this._notifyTabDetached(tabId);
      return detached;
    });
    // Keep reservations until the actual detach has finished; a new session must not
    // acquire a tab while the old session's asynchronous detach is still pending.
    void Promise.allSettled([...detaches, ...this._pendingOperations]).then(() => {
      for (const tabId of this._eligibleTabs) {
        if (this.ownsTab(tabId))
          RelayConnection._owners.delete(tabId);
      }
      this._eligibleTabs.clear();
    });
    this.onclose?.();
  }

  // Forwards chrome.* events concerning attached tabs to the relay, then runs
  // shared detach bookkeeping.
  private _onChromeEvent(fullMethod: string, args: any[]): void {
    const tabId = this._tabIdForEventArgs(fullMethod, args);
    if (tabId === undefined || !this.ownsTab(tabId))
      return;
    if (fullMethod === 'chrome.tabs.onRemoved') {
      this._pendingReattach.delete(tabId);
      this._recentReattach.delete(tabId);
      this._notifyTabDetached(tabId);
      this._eligibleTabs.delete(tabId);
      RelayConnection._owners.delete(tabId);
      this._sendMessage({ method: fullMethod, params: args });
      return;
    }
    if (!this._attachedTabs.has(tabId))
      return;
    if (fullMethod === 'chrome.tabs.onCreated') {
      const tab = args[0] as chrome.tabs.Tab;
      if (tab.id === undefined || !this._reserveTab(tab.id))
        return;
    }
    this._sendMessage({ method: fullMethod, params: args });
    // chrome.debugger.onDetach is the single source of truth for detach bookkeeping.
    if (fullMethod === 'chrome.debugger.onDetach') {
      const reason = args[1] as string | undefined;
      this._notifyTabDetached(tabId);
      if (reason === 'target_closed' && this._maybeScheduleReattach(tabId))
        return;
    }
  }

  private _maybeScheduleReattach(tabId: number): boolean {
    if (this._closed)
      return false;
    if (this._recentReattach.has(tabId)) {
      debugLog(`Not re-attaching tab ${tabId}: re-detached within ${REATTACH_COOLDOWN_MS}ms`);
      return false;
    }
    this._recentReattach.add(tabId);
    setTimeout(() => this._recentReattach.delete(tabId), REATTACH_COOLDOWN_MS);
    this._pendingReattach.add(tabId);
    setTimeout(() => void this._tryReattach(tabId), REATTACH_DELAY_MS);
    return true;
  }

  private _reattachAborted(tabId: number): boolean {
    return this._closed || !this._pendingReattach.has(tabId);
  }

  private async _tryReattach(tabId: number): Promise<void> {
    if (this._reattachAborted(tabId))
      return;
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      this._pendingReattach.delete(tabId);
      return;
    }
    if (this._reattachAborted(tabId))
      return;
    if (this._attachedTabs.has(tabId)) {
      this._pendingReattach.delete(tabId);
      return;
    }
    this.attachTab(tab);
    setTimeout(() => {
      if (this._reattachAborted(tabId))
        return;
      this._pendingReattach.delete(tabId);
    }, REATTACH_VERIFY_MS);
  }

  // Returns the tabId an event refers to, for filtering by _attachedTabs.
  private _tabIdForEventArgs(fullMethod: string, args: any[]): number | undefined {
    switch (fullMethod) {
      case 'chrome.debugger.onEvent':
      case 'chrome.debugger.onDetach':
        return (args[0] as chrome.debugger.Debuggee | undefined)?.tabId;
      case 'chrome.tabs.onCreated': {
        const tab = args[0] as chrome.tabs.Tab;
        // Forward only popups opened by an attached tab; report the opener so cdpRelay
        // can filter / decide. We use the openerTabId for the attached-tab check.
        return tab.openerTabId;
      }
      case 'chrome.tabs.onRemoved':
        return args[0] as number;
    }
    return undefined;
  }

  private _onMessage(event: MessageEvent): void {
    this._onMessageAsync(event).catch(e => debugLog('Error handling message:', e));
  }

  private async _onMessageAsync(event: MessageEvent): Promise<void> {
    let message: ProtocolCommand;
    try {
      message = JSON.parse(event.data);
    } catch (error: any) {
      debugLog(`Error parsing message ${event.data}:`, error);
      this._sendError(-32700, `Error parsing message: ${error.message}`);
      return;
    }

    const response: ProtocolResponse = {
      id: message.id,
    };
    try {
      response.result = await this._track(this._handleCommand(message));
    } catch (error: any) {
      debugLog(`Error handling command ${JSON.stringify(message)}:`, error);
      response.error = error.message;
    }
    this._sendMessage(response);
  }

  private async _handleCommand(message: ProtocolCommand): Promise<any> {
    if (this._closed)
      throw new Error('Session is closed');
    if (!ALLOWED_CHROME_COMMANDS.has(message.method))
      throw new Error(`Unknown method: ${message.method}`);
    const args = (message.params ?? []) as any[];
    // Only tabs explicitly offered to this session (or created by it) are addressable.
    if (message.method.startsWith('chrome.debugger.')) {
      const target = args[0] as chrome.debugger.Debuggee | undefined;
      if (target?.tabId === undefined || target.targetId !== undefined || !this.ownsTab(target.tabId))
        throw new Error('Tab is not owned by this session');
      if (message.method === 'chrome.debugger.sendCommand') {
        if (['Page.bringToFront', 'Target.activateTarget'].includes(args[1]))
          return {};
        if (['Target.createTarget', 'Target.closeTarget', 'Browser.close', 'Browser.crash'].includes(args[1]))
          throw new Error('Use session-scoped tab commands');
        if (['Target.attachToTarget', 'Target.attachToBrowserTarget', 'Target.sendMessageToTarget', 'Browser.setWindowBounds'].includes(args[1]))
          throw new Error('Cross-target commands are not allowed');
      }
    }
    if (message.method === 'chrome.tabs.remove') {
      const tabIds = Array.isArray(args[0]) ? args[0] : [args[0]];
      if (!tabIds.length || tabIds.some((id: number) => !this.ownsTab(id)))
        throw new Error('Tab is not owned by this session');
    }
    if (message.method === 'chrome.tabs.create') {
      const options = args[0] || {};
      if (options.openerTabId !== undefined && !this.ownsTab(options.openerTabId))
        throw new Error('Opener is not owned by this session');
      args[0] = { ...options, active: false };
    }
    const result = await invokeChromeMethod(message.method, args);
    if (message.method === 'chrome.tabs.create' && result?.id !== undefined)
      this._reserveTab(result.id);
    // Attach bookkeeping; detach flows through the chrome.debugger.onDetach event.
    if (message.method === 'chrome.debugger.attach') {
      const target = args[0] as chrome.debugger.Debuggee | undefined;
      if (target?.tabId !== undefined) {
        // The connection may have closed while the attach was pending.
        if (this._closed)
          await detachDebugger(target.tabId);
        else
          this._notifyTabAttached(target.tabId);
      }
    }
    return result ?? {};
  }

  private _sendError(code: number, message: string): void {
    this._sendMessage({
      error: {
        code,
        message,
      },
    });
  }

  private _sendMessage(message: any): void {
    if (this._ws.readyState === WebSocket.OPEN)
      this._ws.send(JSON.stringify(message));
  }
}

// ─── Reflective chrome.* invocation ────────────────────────────────────────

// Resolves chrome.<api>.<member>, shared by command invocation and event
// listener installation.
function resolveChromeMember(fullMethod: string): { obj: any; name: string } {
  const parts = fullMethod.split('.');
  if (parts[0] !== 'chrome' || parts.length < 3)
    throw new Error(`Invalid chrome method: ${fullMethod}`);
  let obj: any = chrome;
  for (let i = 1; i < parts.length - 1; i++) {
    obj = obj?.[parts[i]];
    if (obj === undefined)
      throw new Error(`Unknown chrome path: ${parts.slice(0, i + 1).join('.')}, calling ${fullMethod}`);
  }
  return { obj, name: parts[parts.length - 1] };
}

function detachDebugger(tabId: number): Promise<void> {
  return chrome.debugger.detach({ tabId }).catch(error => {
    debugLog('Error detaching tab:', error);
  });
}

async function invokeChromeMethod(fullMethod: string, args: any[]): Promise<any> {
  const { obj, name } = resolveChromeMember(fullMethod);
  const fn = obj[name] as (...a: any[]) => any;
  if (typeof fn !== 'function')
    throw new Error(`Not a function: ${fullMethod}`);
  return await fn.apply(obj, args);
}

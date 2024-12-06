'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var events = require('events');
var ethRpcErrors = require('eth-rpc-errors');
var postMessageStream = require('@metamask/post-message-stream');

/**
 * this script is live in content-script / dapp's page
 */
class Message extends events.EventEmitter {
    constructor() {
        super(...arguments);
        // avaiable id list
        // max concurrent request limit
        this._requestIdPool = [...Array(1000).keys()];
        this._EVENT_PRE = 'ETH_WALLET_';
        this._waitingMap = new Map();
        this.request = (data) => {
            if (!this._requestIdPool.length) {
                throw ethRpcErrors.ethErrors.rpc.limitExceeded();
            }
            const ident = this._requestIdPool.shift();
            return new Promise((resolve, reject) => {
                this._waitingMap.set(ident, {
                    data,
                    resolve,
                    reject,
                });
                this.send('request', { ident, data });
            });
        };
        this.onResponse = async ({ ident, res, err } = {}) => {
            // the url may update
            if (!this._waitingMap.has(ident)) {
                return;
            }
            const { resolve, reject } = this._waitingMap.get(ident);
            this._requestIdPool.push(ident);
            this._waitingMap.delete(ident);
            err ? reject(err) : resolve(res);
        };
        this.onRequest = async ({ ident, data }) => {
            if (this.listenCallback) {
                let res, err;
                try {
                    res = await this.listenCallback(data);
                }
                catch (e) {
                    err = {
                        message: e.message,
                        stack: e.stack,
                    };
                    e.code && (err.code = e.code);
                    e.data && (err.data = e.data);
                }
                this.send('response', { ident, res, err });
            }
        };
        this._dispose = () => {
            for (const request of this._waitingMap.values()) {
                request.reject(ethRpcErrors.ethErrors.provider.userRejectedRequest());
            }
            this._waitingMap.clear();
        };
    }
}

class BroadcastChannelMessage extends Message {
    constructor({ name, target }) {
        super();
        this.connect = () => {
            this._channel.on("data", ({ data: { type, data } }) => {
                if (type === "message") {
                    this.emit("message", data);
                }
                else if (type === "response") {
                    this.onResponse(data);
                }
            });
            return this;
        };
        this.listen = (listenCallback) => {
            this.listenCallback = listenCallback;
            this._channel.on("data", ({ data: { type, data } }) => {
                if (type === "request") {
                    this.onRequest(data);
                }
            });
            return this;
        };
        this.send = (type, data) => {
            this._channel.write({
                data: {
                    type,
                    data,
                },
            });
        };
        this.dispose = () => {
            this._dispose();
            this._channel.destroy();
        };
        if (!name || !target) {
            throw new Error("the broadcastChannel name or target is missing");
        }
        this._channel = new postMessageStream.WindowPostMessageStream({
            name,
            target,
        });
    }
}

class PushEventHandlers {
    constructor(provider) {
        this.disconnect = () => {
            const disconnectError = ethRpcErrors.ethErrors.provider.disconnected();
            this._emit("accountsChanged", []);
            this._emit("disconnect", null);
            this._emit("close", disconnectError);
        };
        this.accountsChanged = (accounts) => {
            this._emit("accountsChanged", accounts);
        };
        this.chainChanged = (chain) => {
            this._emit("chainChanged", chain);
        };
        this.provider = provider;
    }
    _emit(event, data) {
        if (this.provider._initialized && this.provider._isReady) {
            this.provider.emit(event, data);
        }
    }
}

const domReadyCall = (callback) => {
    if (document.readyState === "loading") {
        const domContentLoadedHandler = () => {
            callback();
            document.removeEventListener("DOMContentLoaded", domContentLoadedHandler);
        };
        document.addEventListener("DOMContentLoaded", domContentLoadedHandler);
    }
    else {
        callback();
    }
};
const $ = document.querySelector.bind(document);
function genUUID() {
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (+c ^
        (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16));
}

class ReadyPromise {
    constructor(count) {
        this._allCheck = [];
        this._tasks = [];
        this.check = (index) => {
            this._allCheck[index - 1] = true;
            this._proceed();
        };
        this.uncheck = (index) => {
            this._allCheck[index - 1] = false;
        };
        this._proceed = () => {
            if (this._allCheck.some((_) => !_)) {
                return;
            }
            while (this._tasks.length) {
                const { resolve, fn } = this._tasks.shift();
                resolve(fn());
            }
        };
        this.call = (fn) => {
            return new Promise((resolve) => {
                this._tasks.push({
                    fn,
                    resolve,
                });
                this._proceed();
            });
        };
        this._allCheck = [...Array(count)];
    }
}

class DedupePromise {
    constructor(blackList) {
        this._tasks = {};
        this._blackList = blackList;
    }
    async call(key, defer) {
        if (this._blackList.includes(key) && this._tasks[key]) {
            throw ethRpcErrors.ethErrors.rpc.transactionRejected('there is a pending request, please request after it resolved');
        }
        return new Promise((resolve) => {
            this._tasks[key] = (this._tasks[key] || 0) + 1;
            resolve(defer().finally(() => {
                this._tasks[key]--;
                if (!this._tasks[key]) {
                    delete this._tasks[key];
                }
            }));
        });
    }
}

const log = (event, ...args) => {
    if (process.env.NODE_ENV !== "production") {
        console.log(`%c [hashpass] (${new Date().toTimeString().substr(0, 8)}) ${event}`, "font-weight: bold; background-color: #7d6ef9; color: white;", ...args);
    }
};
let uuid = genUUID();
const doTabCheckIn = (request) => {
    var _a, _b, _c;
    const origin = location.origin;
    const icon = ((_a = $('head > link[rel~="icon"]')) === null || _a === void 0 ? void 0 : _a.href) ||
        ((_b = $('head > meta[itemprop="image"]')) === null || _b === void 0 ? void 0 : _b.content);
    const name = document.title ||
        ((_c = $('head > meta[name="title"]')) === null || _c === void 0 ? void 0 : _c.content) ||
        origin;
    request({
        method: "tabCheckin",
        params: { icon, name, origin },
    });
};
class EthereumProvider extends events.EventEmitter {
    constructor({ maxListeners = 100 } = {}) {
        super();
        this.selectedAddress = null;
        this.isHashPass = true;
        this._isHashPass = true;
        this._isReady = false;
        this._initialized = false;
        this._cacheRequestsBeforeReady = [];
        this._cacheEventListenersBeforeReady = [];
        this._requestPromise = new ReadyPromise(2);
        this._dedupePromise = new DedupePromise([]);
        this._bcm = new BroadcastChannelMessage({
            name: "hashpass-page-provider",
            target: "hashpass-content-script",
        });
        this.initialize = async () => {
            document.addEventListener("visibilitychange", this._requestPromiseCheckVisibility);
            this._bcm.connect().on("message", this._handleBackgroundMessage);
            domReadyCall(() => {
                doTabCheckIn(this._bcm.request);
                this._requestPromise.check(2);
            });
            this._initialized = true;
            this.emit("_initialized");
        };
        this._requestPromiseCheckVisibility = () => {
            if (document.visibilityState === "visible") {
                this._requestPromise.check(1);
            }
            else {
                this._requestPromise.uncheck(1);
            }
        };
        this._handleBackgroundMessage = ({ event, data }) => {
            log("[push event]", event, data);
            if (this._pushEventHandlers[event]) {
                return this._pushEventHandlers[event](data);
            }
            this.emit(event, data);
        };
        this.isConnected = () => {
            return true;
        };
        this.request = async (data) => {
            if (!this._isReady) {
                const promise = new Promise((resolve, reject) => {
                    this._cacheRequestsBeforeReady.push({
                        data,
                        resolve,
                        reject,
                    });
                });
                return promise;
            }
            return this._dedupePromise.call(data.method, () => this._request(data));
        };
        this._request = async (data) => {
            if (!data) {
                throw ethRpcErrors.ethErrors.rpc.invalidRequest();
            }
            this._requestPromiseCheckVisibility();
            return this._requestPromise.call(() => {
                if (data.method !== "eth_call") {
                    log("[request]", JSON.stringify(data, null, 2));
                }
                return this._bcm
                    .request(data)
                    .then((res) => {
                    if (data.method !== "eth_call") {
                        log("[request: success]", data.method, res);
                    }
                    return res;
                })
                    .catch((err) => {
                    if (data.method !== "eth_call") {
                        log("[request: error]", data.method, ethRpcErrors.serializeError(err));
                    }
                    throw ethRpcErrors.serializeError(err);
                });
            });
        };
        this.sendAsync = (payload, callback) => {
            if (Array.isArray(payload)) {
                return Promise.all(payload.map((item) => new Promise((resolve) => {
                    this.sendAsync(item, (err, res) => {
                        resolve(res);
                    });
                }))).then((result) => callback(null, result));
            }
            const { method, params, ...rest } = payload;
            this.request({ method, params })
                .then((result) => callback(null, { ...rest, method, result }))
                .catch((error) => callback(error, { ...rest, method, error }));
        };
        this.send = (payload, callback) => {
            if (typeof payload === "string" && (!callback || Array.isArray(callback))) {
                return this.request({
                    method: payload,
                    params: callback,
                }).then((result) => ({
                    id: undefined,
                    jsonrpc: "2.0",
                    result,
                }));
            }
            if (typeof payload === "object" && typeof callback === "function") {
                return this.sendAsync(payload, callback);
            }
            let result;
            switch (payload.method) {
                case "eth_accounts":
                    result = this.selectedAddress ? [this.selectedAddress] : [];
                    break;
                default:
                    throw new Error("sync method doesnt support");
            }
            return {
                id: payload.id,
                jsonrpc: payload.jsonrpc,
                result,
            };
        };
        this.shimLegacy = () => {
            const legacyMethods = [
                ["enable", "eth_requestAccounts"],
                ["net_version", "net_version"],
            ];
            for (const [_method, method] of legacyMethods) {
                this[_method] = () => this.request({ method });
            }
        };
        this.on = (event, handler) => {
            if (!this._isReady) {
                this._cacheEventListenersBeforeReady.push([event, handler]);
                return this;
            }
            return super.on(event, handler);
        };
        this.setMaxListeners(maxListeners);
        this.initialize();
        this.shimLegacy();
        this._pushEventHandlers = new PushEventHandlers(this);
    }
}
const provider = new EthereumProvider();
const hashpassProvider = new Proxy(provider, {
    deleteProperty: (target, prop) => {
        if (typeof prop === "string" &&
            ["on", "isHashPass", "isMetaMask", "_isHashPass"].includes(prop)) {
            // @ts-ignore
            delete target[prop];
        }
        return true;
    },
});
const initProvider = () => {
    hashpassProvider._isReady = true;
    hashpassProvider.on("contentScriptConnected", () => {
        doTabCheckIn(hashpassProvider.request);
    });
    const descriptor = Object.getOwnPropertyDescriptor(window, "ethereum");
    const canDefine = !descriptor || descriptor.configurable;
    if (canDefine) {
        try {
            Object.defineProperties(window, {
                hashpass: {
                    value: hashpassProvider,
                    configurable: false,
                    writable: false,
                },
                hashpassWalletRouter: {
                    value: {
                        hashpassProvider,
                        lastInjectedProvider: window.ethereum,
                        currentProvider: hashpassProvider,
                        providers: [
                            hashpassProvider,
                            ...(window.ethereum ? [window.ethereum] : []),
                        ],
                        addProvider(provider) {
                            if (!window.hashpassWalletRouter.providers.includes(provider)) {
                                window.hashpassWalletRouter.providers.push(provider);
                            }
                            if (hashpassProvider !== provider) {
                                window.hashpassWalletRouter.lastInjectedProvider = provider;
                            }
                        },
                    },
                    configurable: false,
                    writable: false,
                },
            });
        }
        catch (e) {
            console.error(e);
            window.hashpass = hashpassProvider;
        }
    }
    else {
        window.hashpass = hashpassProvider;
    }
};
initProvider();
const announceEip6963Provider = (provider) => {
    const info = {
        uuid: uuid,
        name: "hashpass",
        icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAAXNSR0IArs4c6QAAASpJREFUWIXtmLFthDAUhs9JCkqP4A3sktJ0dLABlHSswAgwgdnk8ASYCeySzpR0lyYnXSSIMeEiTnlf+/R+f/KTnixfLgAA/DPe1wpCiCiKgiAYx3Ge50MOwxjHcVwURRiGXdf5NWutb3f6vhdCZFnGGPOVYIyVZSmEeAy8Xq++Od+EHtFab0zAGFtrF0N+EHrzFSWEbBfCGPvmews9GxByAUIuQMjF6YQ+dnemaZokyWKpaRql1F8LMcbyPF8sSSl3C51uZCDkAoRcgJCL/Xuobdu1h/ruJfQrIWOMMWZ3+xqnGxkIuQAhFyDk4vWFpml6jskXmza1uiOl3L6djTEIIc45pZRzTgjZ8puD1gpVVVlrh2FQSh11KxhjxhilFCFU1/UhmQAAvDyfrvqhwVTAsDoAAAAASUVORK5CYII=",
        rdns: "io.hashpass",
    };
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({ info, provider }),
    }));
};
window.addEventListener("eip6963:requestProvider", (event) => {
    announceEip6963Provider(hashpassProvider);
});
announceEip6963Provider(hashpassProvider);
window.dispatchEvent(new Event("ethereum#initialized"));

exports.EthereumProvider = EthereumProvider;

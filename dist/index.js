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
        // connect = (data) => {
        //   if (!this.provider._isConnected) {
        //     this.provider._isConnected = true;
        //     this.provider._state.isConnected = true;
        //     this._emit("connect", data);
        //   }
        // };
        // unlock = () => {
        //   this.provider._isUnlocked = true;
        //   this.provider._state.isUnlocked = true;
        // };
        // lock = () => {
        //   this.provider._isUnlocked = false;
        // };
        this.disconnect = () => {
            // this.provider._isConnected = false;
            // this.provider._state.isConnected = false;
            // this.provider._state.accounts = null;
            // this.provider.selectedAddress = null;
            const disconnectError = ethRpcErrors.ethErrors.provider.disconnected();
            this._emit("accountsChanged", []);
            this._emit("disconnect", disconnectError);
            this._emit("close", disconnectError);
        };
        this.accountsChanged = (accounts) => {
            this._emit("accountsChanged", accounts);
        };
        this.chainChanged = ({ chain, networkVersion }) => {
            // this.connect({ chainId: chain });
            // if (chain !== this.provider.chainId) {
            //   this.provider.chainId = chain;
            this._emit("chainChanged", chain);
            // }
            // if (networkVersion !== this.provider.networkVersion) {
            //   this.provider.networkVersion = networkVersion;
            //   this._emit("networkChanged", networkVersion);
            // }
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
        // chainId: string | null = null;
        this.selectedAddress = null;
        /**
         * The network ID of the currently connected Ethereum chain.
         * @deprecated
         */
        // networkVersion: string | null = null;
        this.isHashPass = true;
        this._isHashPass = true;
        this._isReady = false;
        // _isConnected = false;
        this._initialized = false;
        // _isUnlocked = false;
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
            // this._state.initialized = true;
            this.emit("_initialized");
            // try {
            //   const { chainId, accounts, networkVersion, isUnlocked }: any =
            //     await this.requestInternalMethods({
            //       method: "getProviderState",
            //     });
            //   if (isUnlocked) {
            //     this._isUnlocked = true;
            //     this._state.isUnlocked = true;
            //   }
            //   this.chainId = chainId;
            //   this.networkVersion = networkVersion;
            //   this.emit("connect", { chainId });
            //   this._pushEventHandlers.chainChanged({
            //     chain: chainId,
            //     networkVersion,
            //   });
            //   this._pushEventHandlers.accountsChanged(accounts);
            // } catch {
            //   //
            // } finally {
            //   this._initialized = true;
            //   this._state.initialized = true;
            //   this.emit("_initialized");
            // }
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
        // TODO: support multi request!
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
        // requestInternalMethods = (data) => {
        //   return this._dedupePromise.call(data.method, () => this._request(data));
        // };
        // shim to matamask legacy api
        this.sendAsync = (payload, callback) => {
            if (Array.isArray(payload)) {
                return Promise.all(payload.map((item) => new Promise((resolve) => {
                    this.sendAsync(item, (err, res) => {
                        // ignore error
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
                // send(method, params? = [])
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
// const requestHasOtherProvider = () => {
//   return provider.requestInternalMethods({
//     method: "hasOtherProvider",
//     params: [],
//   });
// };
// const requestIsDefaultWallet = () => {
//   return provider.requestInternalMethods({
//     method: "isDefaultWallet",
//     params: [],
//   }) as Promise<boolean>;
// };
const initProvider = () => {
    hashpassProvider._isReady = true;
    // hashpassProvider.on("defaultWalletChanged", switchWalletNotice);
    hashpassProvider.on("contentScriptConnected", () => {
        doTabCheckIn(hashpassProvider.request);
    });
    // patchProvider(hashpassProvider);
    // if (window.ethereum) {
    //   requestHasOtherProvider();
    // }
    // if (!window.web3) {
    //   window.web3 = {
    //     currentProvider: hashpassProvider,
    //   };
    // }
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
                // ethereum: {
                //   get() {
                //     return window.hashpassWalletRouter.currentProvider;
                //   },
                //   set(newProvider) {
                //     window.hashpassWalletRouter.addProvider(newProvider);
                //   },
                //   configurable: false,
                // },
                hashpassWalletRouter: {
                    value: {
                        hashpassProvider,
                        lastInjectedProvider: window.ethereum,
                        currentProvider: hashpassProvider,
                        providers: [
                            hashpassProvider,
                            ...(window.ethereum ? [window.ethereum] : []),
                        ],
                        // setDefaultProvider(hashpassAsDefault: boolean) {
                        //   if (hashpassAsDefault) {
                        //     window.hashpassWalletRouter.currentProvider = window.hashpass;
                        //   } else {
                        //     const nonDefaultProvider =
                        //       window.hashpassWalletRouter.lastInjectedProvider ??
                        //       window.ethereum;
                        //     window.hashpassWalletRouter.currentProvider = nonDefaultProvider;
                        //   }
                        //   if (
                        //     hashpassAsDefault ||
                        //     !window.hashpassWalletRouter.lastInjectedProvider
                        //   ) {
                        //     hashpassProvider.on("hashpass:chainChanged", switchChainNotice);
                        //   }
                        // },
                        addProvider(provider) {
                            if (!window.hashpassWalletRouter.providers.includes(provider)) {
                                window.hashpassWalletRouter.providers.push(provider);
                            }
                            if (hashpassProvider !== provider) {
                                // requestHasOtherProvider();
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
            // think that defineProperty failed means there is any other wallet
            // requestHasOtherProvider();
            console.error(e);
            // window.ethereum = hashpassProvider;
            window.hashpass = hashpassProvider;
        }
    }
    else {
        // window.ethereum = hashpassProvider;
        window.hashpass = hashpassProvider;
    }
};
initProvider();
// requestIsDefaultWallet().then((hashpassAsDefault) => {
//   window.hashpassWalletRouter?.setDefaultProvider(hashpassAsDefault);
// });
const announceEip6963Provider = (provider) => {
    const info = {
        uuid: uuid,
        name: "hashpass Wallet",
        icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAwXzc0MV8yNzUxKSI+CjxtYXNrIGlkPSJtYXNrMF83NDFfMjc1MSIgc3R5bGU9Im1hc2stdHlwZTpsdW1pbmFuY2UiIG1hc2tVbml0cz0idXNlclNwYWNlT25Vc2UiIHg9IjAiIHk9IjAiIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+CjxwYXRoIGQ9Ik0zMiAxNkMzMiA3LjE2MzQ0IDI0LjgzNjYgMCAxNiAwQzcuMTYzNDQgMCAwIDcuMTYzNDQgMCAxNkMwIDI0LjgzNjYgNy4xNjM0NCAzMiAxNiAzMkMyNC44MzY2IDMyIDMyIDI0LjgzNjYgMzIgMTZaIiBmaWxsPSJ3aGl0ZSIvPgo8L21hc2s+CjxnIG1hc2s9InVybCgjbWFzazBfNzQxXzI3NTEpIj4KPHBhdGggZD0iTTMyIDE2QzMyIDcuMTYzNDQgMjQuODM2NiAwIDE2IDBDNy4xNjM0NCAwIDAgNy4xNjM0NCAwIDE2QzAgMjQuODM2NiA3LjE2MzQ0IDMyIDE2IDMyQzI0LjgzNjYgMzIgMzIgMjQuODM2NiAzMiAxNloiIGZpbGw9IiM3MDg0RkYiLz4KPGcgZmlsdGVyPSJ1cmwoI2ZpbHRlcjBfZF83NDFfMjc1MSkiPgo8cGF0aCBkPSJNMjcuNjAxOSAxNy4zODc2QzI4LjUyMTYgMTUuMzI2MSAyMy45NzQ4IDkuNTY2MzIgMTkuNjMxIDcuMTY2NzZDMTYuODkyOSA1LjMwNzc5IDE0LjAzOTkgNS41NjMxOCAxMy40NjIgNi4zNzkzOEMxMi4xOTQgOC4xNzA2OSAxNy42NjExIDkuNjg4NTEgMjEuMzE3NCAxMS40NTk3QzIwLjUzMTQgMTEuODAyMiAxOS43OTA4IDEyLjQxNjkgMTkuMzU1MiAxMy4yMDI5QzE3Ljk5MjEgMTEuNzA5OCAxNS4wMDAzIDEwLjQyMzkgMTEuNDg5NyAxMS40NTk3QzkuMTIzOTcgMTIuMTU3NyA3LjE1NzkxIDEzLjgwMzIgNi4zOTgwNCAxNi4yODg1QzYuMjEzMzcgMTYuMjA2MiA2LjAwODk0IDE2LjE2MDQgNS43OTM4NyAxNi4xNjA0QzQuOTcxNDIgMTYuMTYwNCA0LjMwNDY5IDE2LjgyOTQgNC4zMDQ2OSAxNy42NTQ2QzQuMzA0NjkgMTguNDc5OSA0Ljk3MTQyIDE5LjE0ODggNS43OTM4NyAxOS4xNDg4QzUuOTQ2MzIgMTkuMTQ4OCA2LjQyMjk4IDE5LjA0NjMgNi40MjI5OCAxOS4wNDYzTDE0LjAzOTkgMTkuMTAxNkMxMC45OTM3IDIzLjk1MDQgOC41ODYzNSAyNC42NTkxIDguNTg2MzUgMjUuNDk5MkM4LjU4NjM1IDI2LjMzOTIgMTAuODg5OCAyNi4xMTE2IDExLjc1NDcgMjUuNzk4NEMxNS44OTQ5IDI0LjI5OTUgMjAuMzQxNyAxOS42MjggMjEuMTA0OCAxOC4yODMzQzI0LjMwOTIgMTguNjg0NCAyNy4wMDIyIDE4LjczMTggMjcuNjAxOSAxNy4zODc2WiIgZmlsbD0idXJsKCNwYWludDBfbGluZWFyXzc0MV8yNzUxKSIvPgo8cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGNsaXAtcnVsZT0iZXZlbm9kZCIgZD0iTTIxLjMwMjkgMTEuNDUzOEMyMS4zMDY3IDExLjQ1NTUgMjEuMzEwNiAxMS40NTcxIDIxLjMxNDQgMTEuNDU4OEMyMS40ODM5IDExLjM5MTggMjEuNDU2NSAxMS4xNDA3IDIxLjQwOTkgMTAuOTQzNUMyMS4zMDMgMTAuNDkwMSAxOS40NTc1IDguNjYxNjUgMTcuNzI0NSA3Ljg0MjY1QzE1LjM2MjkgNi43MjY2NSAxMy42MjQgNi43ODQyMSAxMy4zNjcyIDcuMjk4NjVDMTMuODQ3MiA4LjI4ODIxIDE2LjA3NzkgOS4yMTcyNyAxOC40MDc3IDEwLjE4NzZDMTkuMzk3MSAxMC41OTk2IDIwLjQwNDMgMTEuMDE5MSAyMS4zMDI5IDExLjQ1MzhaIiBmaWxsPSJ1cmwoI3BhaW50MV9saW5lYXJfNzQxXzI3NTEpIi8+CjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBkPSJNMTguMzIyOCAyMS40MTY3QzE3Ljg0NTMgMjEuMjMzNyAxNy4zMDYgMjEuMDY1OCAxNi42OTI5IDIwLjkxMzNDMTcuMzQ2OSAxOS43MzkzIDE3LjQ4NDEgMTguMDAxMSAxNi44NjY1IDE2LjkwMjJDMTUuOTk5OCAxNS4zNTk5IDE0LjkxMTcgMTQuNTM5MSAxMi4zODM0IDE0LjUzOTFDMTAuOTkyOCAxNC41MzkxIDcuMjQ4NzcgMTUuMDA5IDcuMTgyMjcgMTguMTQ1QzcuMTc1MzQgMTguNDczOCA3LjE4MjA5IDE4Ljc3NTEgNy4yMDU3NyAxOS4wNTIxTDE0LjA0MyAxOS4xMDE5QzEzLjEyMSAyMC41Njk0IDEyLjI1NzUgMjEuNjU3NyAxMS41MDE2IDIyLjQ4NTJDMTIuNDA5MiAyMi43MTg2IDEzLjE1ODEgMjIuOTE0NCAxMy44NDU3IDIzLjA5NDNDMTQuNDk3OCAyMy4yNjQ4IDE1LjA5NDYgMjMuNDIwOSAxNS43MTkzIDIzLjU4MDlDMTYuNjYyIDIyLjg5MTggMTcuNTQ4MyAyMi4xNDA0IDE4LjMyMjggMjEuNDE2N1oiIGZpbGw9InVybCgjcGFpbnQyX2xpbmVhcl83NDFfMjc1MSkiLz4KPHBhdGggZD0iTTYuMzA4NzQgMTguNzI4M0M2LjU4ODA1IDIxLjExMDUgNy45MzczNiAyMi4wNDQxIDEwLjY5NDYgMjIuMzIwNUMxMy40NTE5IDIyLjU5NjggMTUuMDMzNSAyMi40MTE0IDE3LjEzOTEgMjIuNjAzNkMxOC44OTc3IDIyLjc2NDEgMjAuNDY4IDIzLjY2MzMgMjEuMDUwNSAyMy4zNTI2QzIxLjU3NDcgMjMuMDczIDIxLjI4MTQgMjIuMDYyNiAyMC41Nzk5IDIxLjQxNDRDMTkuNjcwNiAyMC41NzQxIDE4LjQxMjEgMTkuOTkgMTYuMTk3NyAxOS43ODI2QzE2LjYzOSAxOC41NzAyIDE2LjUxNTQgMTYuODcwMyAxNS44Mjk5IDE1Ljk0NTVDMTQuODM4OSAxNC42MDgyIDEzLjAwOTcgMTQuMDAzNiAxMC42OTQ2IDE0LjI2NzhDOC4yNzU4NiAxNC41NDM4IDUuOTU4MjEgMTUuNzM4NiA2LjMwODc0IDE4LjcyODNaIiBmaWxsPSJ1cmwoI3BhaW50M19saW5lYXJfNzQxXzI3NTEpIi8+CjwvZz4KPC9nPgo8L2c+CjxkZWZzPgo8ZmlsdGVyIGlkPSJmaWx0ZXIwX2RfNzQxXzI3NTEiIHg9Ii03Ny42MTUzIiB5PSItNzYuMTYwMiIgd2lkdGg9IjE4Ny4yNTQiIGhlaWdodD0iMTg0LjE2MiIgZmlsdGVyVW5pdHM9InVzZXJTcGFjZU9uVXNlIiBjb2xvci1pbnRlcnBvbGF0aW9uLWZpbHRlcnM9InNSR0IiPgo8ZmVGbG9vZCBmbG9vZC1vcGFjaXR5PSIwIiByZXN1bHQ9IkJhY2tncm91bmRJbWFnZUZpeCIvPgo8ZmVDb2xvck1hdHJpeCBpbj0iU291cmNlQWxwaGEiIHR5cGU9Im1hdHJpeCIgdmFsdWVzPSIwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAxMjcgMCIgcmVzdWx0PSJoYXJkQWxwaGEiLz4KPGZlT2Zmc2V0Lz4KPGZlR2F1c3NpYW5CbHVyIHN0ZERldmlhdGlvbj0iNDAuOTYiLz4KPGZlQ29tcG9zaXRlIGluMj0iaGFyZEFscGhhIiBvcGVyYXRvcj0ib3V0Ii8+CjxmZUNvbG9yTWF0cml4IHR5cGU9Im1hdHJpeCIgdmFsdWVzPSIwIDAgMCAwIDAuMTUxOTMzIDAgMCAwIDAgMC4yMzkyMzggMCAwIDAgMCAwLjQ5MDI0MSAwIDAgMCAwLjU0IDAiLz4KPGZlQmxlbmQgbW9kZT0ibm9ybWFsIiBpbjI9IkJhY2tncm91bmRJbWFnZUZpeCIgcmVzdWx0PSJlZmZlY3QxX2Ryb3BTaGFkb3dfNzQxXzI3NTEiLz4KPGZlQmxlbmQgbW9kZT0ibm9ybWFsIiBpbj0iU291cmNlR3JhcGhpYyIgaW4yPSJlZmZlY3QxX2Ryb3BTaGFkb3dfNzQxXzI3NTEiIHJlc3VsdD0ic2hhcGUiLz4KPC9maWx0ZXI+CjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl83NDFfMjc1MSIgeDE9IjExLjIxNDIiIHkxPSIxNS41NjIiIHgyPSIyNy40MTE5IiB5Mj0iMjAuMTM5OSIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSJ3aGl0ZSIvPgo8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IndoaXRlIi8+CjwvbGluZWFyR3JhZGllbnQ+CjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQxX2xpbmVhcl83NDFfMjc1MSIgeDE9IjI0LjY3NDUiIHkxPSIxNS4yNTE4IiB4Mj0iMTIuOTUzNiIgeTI9IjMuNTQxNjMiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KPHN0b3Agc3RvcC1jb2xvcj0iIzg2OTdGRiIvPgo8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM4Njk3RkYiIHN0b3Atb3BhY2l0eT0iMCIvPgo8L2xpbmVhckdyYWRpZW50Pgo8bGluZWFyR3JhZGllbnQgaWQ9InBhaW50Ml9saW5lYXJfNzQxXzI3NTEiIHgxPSIxOC42NDc4IiB5MT0iMjEuODI2MSIgeDI9IjcuNDA4MDIiIHkyPSIxNS4zODU5IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CjxzdG9wIHN0b3AtY29sb3I9IiM4Njk3RkYiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjODY5N0ZGIiBzdG9wLW9wYWNpdHk9IjAiLz4KPC9saW5lYXJHcmFkaWVudD4KPGxpbmVhckdyYWRpZW50IGlkPSJwYWludDNfbGluZWFyXzc0MV8yNzUxIiB4MT0iMTIuMTgyNyIgeTE9IjE1LjQzOTQiIHgyPSIxOS43OTkxIiB5Mj0iMjUuMDg0MyIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSJ3aGl0ZSIvPgo8c3RvcCBvZmZzZXQ9IjAuOTgzODk1IiBzdG9wLWNvbG9yPSIjRDFEOEZGIi8+CjwvbGluZWFyR3JhZGllbnQ+CjxjbGlwUGF0aCBpZD0iY2xpcDBfNzQxXzI3NTEiPgo8cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIGZpbGw9IndoaXRlIi8+CjwvY2xpcFBhdGg+CjwvZGVmcz4KPC9zdmc+Cg==",
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

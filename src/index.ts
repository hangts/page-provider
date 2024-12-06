import { EventEmitter } from "events";
import { ethErrors, serializeError } from "eth-rpc-errors";
import BroadcastChannelMessage from "./utils/message/broadcastChannelMessage";
import PushEventHandlers from "./pageProvider/pushEventHandlers";
import { domReadyCall, $, genUUID } from "./pageProvider/utils";
import ReadyPromise from "./pageProvider/readyPromise";
import DedupePromise from "./pageProvider/dedupePromise";

const log = (event, ...args) => {
  if (process.env.NODE_ENV !== "production") {
    console.log(
      `%c [hashpass] (${new Date().toTimeString().substr(0, 8)}) ${event}`,
      "font-weight: bold; background-color: #7d6ef9; color: white;",
      ...args
    );
  }
};

let uuid = genUUID();
export interface Interceptor {
  onRequest?: (data: any) => any;
  onResponse?: (res: any, data: any) => any;
}

interface StateProvider {
  accounts: string[] | null;
  isConnected: boolean;
  isUnlocked: boolean;
  initialized: boolean;
  isPermanentlyDisconnected: boolean;
}

interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

interface EIP6963RequestProviderEvent extends Event {
  type: "eip6963:requestProvider";
}

const doTabCheckIn = (request: (data: any) => void) => {
  const origin = location.origin;
  const icon =
    ($('head > link[rel~="icon"]') as HTMLLinkElement)?.href ||
    ($('head > meta[itemprop="image"]') as HTMLMetaElement)?.content;

  const name =
    document.title ||
    ($('head > meta[name="title"]') as HTMLMetaElement)?.content ||
    origin;

  request({
    method: "tabCheckin",
    params: { icon, name, origin },
  });
};

export class EthereumProvider extends EventEmitter {
  selectedAddress: string | null = null;
  isHashPass = true;
  _isHashPass = true;

  _isReady = false;
  _initialized = false;

  _cacheRequestsBeforeReady: any[] = [];
  _cacheEventListenersBeforeReady: [string | symbol, () => any][] = [];

  private _pushEventHandlers: PushEventHandlers;
  private _requestPromise = new ReadyPromise(2);
  private _dedupePromise = new DedupePromise([]);
  private _bcm = new BroadcastChannelMessage({
    name: "hashpass-page-provider",
    target: "hashpass-content-script",
  });

  constructor({ maxListeners = 100 } = {}) {
    super();
    this.setMaxListeners(maxListeners);
    this.initialize();
    this.shimLegacy();
    this._pushEventHandlers = new PushEventHandlers(this);
  }

  initialize = async () => {
    document.addEventListener(
      "visibilitychange",
      this._requestPromiseCheckVisibility
    );

    this._bcm.connect().on("message", this._handleBackgroundMessage);
    domReadyCall(() => {
      doTabCheckIn(this._bcm.request);
      this._requestPromise.check(2);
    });
    this._initialized = true;
    this.emit("_initialized");
  };

  private _requestPromiseCheckVisibility = () => {
    if (document.visibilityState === "visible") {
      this._requestPromise.check(1);
    } else {
      this._requestPromise.uncheck(1);
    }
  };

  private _handleBackgroundMessage = ({ event, data }) => {
    log("[push event]", event, data);
    if (this._pushEventHandlers[event]) {
      return this._pushEventHandlers[event](data);
    }

    this.emit(event, data);
  };

  isConnected = () => {
    return true;
  };
  request = async (data) => {
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

  _request = async (data) => {
    if (!data) {
      throw ethErrors.rpc.invalidRequest();
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
            log("[request: error]", data.method, serializeError(err));
          }
          throw serializeError(err);
        });
    });
  };

  sendAsync = (payload, callback) => {
    if (Array.isArray(payload)) {
      return Promise.all(
        payload.map(
          (item) =>
            new Promise((resolve) => {
              this.sendAsync(item, (err, res) => {
                resolve(res);
              });
            })
        )
      ).then((result) => callback(null, result));
    }
    const { method, params, ...rest } = payload;
    this.request({ method, params })
      .then((result) => callback(null, { ...rest, method, result }))
      .catch((error) => callback(error, { ...rest, method, error }));
  };

  send = (payload, callback?) => {
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

  shimLegacy = () => {
    const legacyMethods = [
      ["enable", "eth_requestAccounts"],
      ["net_version", "net_version"],
    ];

    for (const [_method, method] of legacyMethods) {
      this[_method] = () => this.request({ method });
    }
  };

  on = (event: string | symbol, handler: (...args: any[]) => void) => {
    if (!this._isReady) {
      this._cacheEventListenersBeforeReady.push([event, handler]);
      return this;
    }
    return super.on(event, handler);
  };
}

declare global {
  interface Window {
    ethereum: EthereumProvider;
    web3: any;
    hashpass: EthereumProvider;
    hashpassWalletRouter: {
      hashpassProvider: EthereumProvider;
      lastInjectedProvider?: EthereumProvider;
      currentProvider: EthereumProvider;
      providers: EthereumProvider[];
      setDefaultProvider: (hashpassAsDefault: boolean) => void;
      addProvider: (provider: EthereumProvider) => void;
    };
  }
}

const provider = new EthereumProvider();

const hashpassProvider = new Proxy(provider, {
  deleteProperty: (target, prop) => {
    if (
      typeof prop === "string" &&
      ["on", "isHashPass", "isMetaMask", "_isHashPass"].includes(prop)
    ) {
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
    } catch (e) {
      console.error(e);
      window.hashpass = hashpassProvider;
    }
  } else {
    window.hashpass = hashpassProvider;
  }
};

initProvider();

const announceEip6963Provider = (provider: EthereumProvider) => {
  const info: EIP6963ProviderInfo = {
    uuid: uuid,
    name: "hashpass",
    icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAAXNSR0IArs4c6QAAASpJREFUWIXtmLFthDAUhs9JCkqP4A3sktJ0dLABlHSswAgwgdnk8ASYCeySzpR0lyYnXSSIMeEiTnlf+/R+f/KTnixfLgAA/DPe1wpCiCiKgiAYx3Ge50MOwxjHcVwURRiGXdf5NWutb3f6vhdCZFnGGPOVYIyVZSmEeAy8Xq++Od+EHtFab0zAGFtrF0N+EHrzFSWEbBfCGPvmews9GxByAUIuQMjF6YQ+dnemaZokyWKpaRql1F8LMcbyPF8sSSl3C51uZCDkAoRcgJCL/Xuobdu1h/ruJfQrIWOMMWZ3+xqnGxkIuQAhFyDk4vWFpml6jskXmza1uiOl3L6djTEIIc45pZRzTgjZ8puD1gpVVVlrh2FQSh11KxhjxhilFCFU1/UhmQAAvDyfrvqhwVTAsDoAAAAASUVORK5CYII=",
    rdns: "io.hashpass",
  };

  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info, provider }),
    })
  );
};

window.addEventListener<any>(
  "eip6963:requestProvider",
  (event: EIP6963RequestProviderEvent) => {
    announceEip6963Provider(hashpassProvider);
  }
);

announceEip6963Provider(hashpassProvider);

window.dispatchEvent(new Event("ethereum#initialized"));

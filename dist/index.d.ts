/// <reference types="node" />
import { EventEmitter } from "events";
export interface Interceptor {
    onRequest?: (data: any) => any;
    onResponse?: (res: any, data: any) => any;
}
export declare class EthereumProvider extends EventEmitter {
    selectedAddress: string | null;
    isHashPass: boolean;
    _isHashPass: boolean;
    _isReady: boolean;
    _initialized: boolean;
    _cacheRequestsBeforeReady: any[];
    _cacheEventListenersBeforeReady: [string | symbol, () => any][];
    private _pushEventHandlers;
    private _requestPromise;
    private _dedupePromise;
    private _bcm;
    constructor({ maxListeners }?: {
        maxListeners?: number | undefined;
    });
    initialize: () => Promise<void>;
    private _requestPromiseCheckVisibility;
    private _handleBackgroundMessage;
    isConnected: () => boolean;
    request: (data: any) => Promise<unknown>;
    _request: (data: any) => Promise<unknown>;
    sendAsync: (payload: any, callback: any) => Promise<any> | undefined;
    send: (payload: any, callback?: any) => Promise<any> | {
        id: any;
        jsonrpc: any;
        result: any;
    } | undefined;
    shimLegacy: () => void;
    on: (event: string | symbol, handler: (...args: any[]) => void) => this;
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

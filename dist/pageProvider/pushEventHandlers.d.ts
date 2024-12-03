import { EthereumProvider } from "../index";
declare class PushEventHandlers {
    provider: EthereumProvider;
    constructor(provider: any);
    _emit(event: any, data: any): void;
    disconnect: () => void;
    accountsChanged: (accounts: any) => void;
    chainChanged: (chain: any) => void;
}
export default PushEventHandlers;

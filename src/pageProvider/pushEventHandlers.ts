import { ethErrors } from "eth-rpc-errors";
import { EthereumProvider } from "../index";

class PushEventHandlers {
  provider: EthereumProvider;

  constructor(provider) {
    this.provider = provider;
  }

  _emit(event, data) {
    if (this.provider._initialized && this.provider._isReady) {
      this.provider.emit(event, data);
    }
  }

  disconnect = () => {
    const disconnectError = ethErrors.provider.disconnected();
    this._emit("accountsChanged", []);
    this._emit("disconnect", null);
    this._emit("close", disconnectError);
  };

  accountsChanged = (accounts) => {
    this._emit("accountsChanged", accounts);
  };

  chainChanged = (chain) => {
    this._emit("chainChanged", chain);
  };
}

export default PushEventHandlers;

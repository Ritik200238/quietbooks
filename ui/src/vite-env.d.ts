/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** undeployed | devnet | testnet. Must match the network the wallet is on. */
  readonly VITE_NETWORK_ID?: string;
  readonly VITE_INDEXER_URI?: string;
  readonly VITE_INDEXER_WS_URI?: string;
  readonly VITE_PROOF_SERVER_URI?: string;
  readonly VITE_ZK_CONFIG_URI?: string;
  readonly VITE_LOG_LEVEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

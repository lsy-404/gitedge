import type { Crypto as WorkerCrypto } from "@cloudflare/workers-types/experimental";

declare global {
  interface Crypto extends WorkerCrypto {}
}

export {};

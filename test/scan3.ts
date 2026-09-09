import { SimplePool } from "nostr-tools/pool";
import { deriveTradeKeys, generateMnemonic, unwrapMessageNip44 } from "../src/protocol/index.js";
async function main() {
  const pool = new SimplePool();
  const identity = deriveTradeKeys("c2bc65a72a03123a x", 0); // placeholder - will fail
  pool.close(["ws://localhost:7080"]);
}
main().catch(()=>{});

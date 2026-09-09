import { SimplePool } from "nostr-tools/pool";
import { deriveTradeKeys, unwrapMessageNip44 } from "../src/protocol/index.js";
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
async function main() {
  const pool = new SimplePool();
  const identity = deriveTradeKeys(MNEMONIC, 0);
  const mostro = "6c4b8b42b8bda8e59a155788271ba54febe8bd1dbf1319f3ff0a68d9770ecbbe";
  const evs = await pool.querySync(["ws://localhost:7080"], { kinds: [14], authors: [mostro], "#p": [identity.pubkey] });
  for (const e of evs.slice(-4)) {
    const u = unwrapMessageNip44({ event: { kind: e.kind, pubkey: e.pubkey, content: e.content }, receiverSecretHex: identity.secret });
    console.log(new Date(e.created_at*1000).toISOString(), u?.message.value.action, "payload:", JSON.stringify(u?.message.value.payload));
  }
  pool.close(["ws://localhost:7080"]);
}
main();

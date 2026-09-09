#!/bin/sh
# Regtest stack initializer (idempotent).
#
# Waits for bitcoind + both LND nodes, then:
#   1. creates the bitcoind wallet and mines 101 blocks (mature coinbase)
#   2. funds lnd-alice and lnd-bob
#   3. connects bob -> alice and opens a 2M sats alice<->bob channel
#   4. mines confirmations for the channel
#
# Mounted LND dirs (read-only): alice at /alice/.lnd, bob at /bob/.lnd.
# Runs from the bitcoind image (has bitcoin-cli) with lncli copied in.

set -e

BTC="bitcoin-cli -regtest -rpcuser=bitcoinrpc -rpcpassword=regtestpass -rpcconnect=bitcoind -rpcport=18443"
LNCLI_A="lncli --lnddir=/alice/.lnd --network=regtest --rpcserver=lnd-alice:10009"
LNCLI_B="lncli --lnddir=/bob/.lnd --network=regtest --rpcserver=lnd-bob:11009"

log() { echo "[init] $*"; }

wait_for() {
  local cmd="$1" name="$2"
  log "waiting for $name..."
  for i in $(seq 1 180); do
    if $cmd >/dev/null 2>&1; then
      log "$name ready (${i}s)"
      return 0
    fi
    sleep 1
  done
  log "ERROR: $name not ready after 180s"
  $cmd 2>&1 | head -5
  exit 1
}

# ---- 1. bitcoind + wallet + mature blocks ----
wait_for "$BTC getblockcount" "bitcoind"

if ! $BTC createwallet "" >/dev/null 2>&1; then
  log "wallet already exists, skipping create"
fi

MINER_ADDR=$($BTC getnewaddress)
if [ "$($BTC getblockcount)" -lt 101 ]; then
  log "mining to block 101 (mature coinbase)..."
  $BTC generatetoaddress $((101 - $($BTC getblockcount))) "$MINER_ADDR" >/dev/null
else
  log "already at >= 101 blocks"
fi

# ---- 2. fund both LND nodes ----
wait_for "$LNCLI_A getinfo" "lnd-alice"
wait_for "$LNCLI_B getinfo" "lnd-bob"

A_ADDR=$($LNCLI_A newaddress p2wkh | grep -o '"address": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
B_ADDR=$($LNCLI_B newaddress p2wkh | grep -o '"address": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')

A_BAL=$($LNCLI_A walletbalance | grep -o '"total_balance": *"[0-9]*"' | sed 's/[^0-9]//g')
B_BAL=$($LNCLI_B walletbalance | grep -o '"total_balance": *"[0-9]*"' | sed 's/[^0-9]//g')

if [ "${A_BAL:-0}" -lt 1000000 ]; then
  log "funding alice (balance $A_BAL)..."
  $BTC sendtoaddress "$A_ADDR" 5 >/dev/null
fi
if [ "${B_BAL:-0}" -lt 1000000 ]; then
  log "funding bob (balance $B_BAL)..."
  $BTC sendtoaddress "$B_ADDR" 5 >/dev/null
fi
log "confirming funding txs..."
$BTC generatetoaddress 3 "$MINER_ADDR" >/dev/null

# ---- 3. connect bob -> alice, open channel ----
A_PUB=$($LNCLI_A getinfo | grep -o '"identity_pubkey": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
B_PUB=$($LNCLI_B getinfo | grep -o '"identity_pubkey": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
log "alice=$A_PUB bob=$B_PUB"

if ! $LNCLI_B listpeers 2>/dev/null | grep -q "$A_PUB"; then
  log "connecting bob -> alice..."
  $LNCLI_B connect "$A_PUB"@lnd-alice:9735
else
  log "peers already connected"
fi

if $LNCLI_A listchannels 2>/dev/null | grep -q '"active": *true'; then
  log "channel already active, skipping open"
else
  log "opening 2M sats channel alice -> bob..."
  $LNCLI_A openchannel --node_key="$B_PUB" --local_amt=2000000 --push_amt=0 --sat_per_vbyte=1 >/dev/null
  log "mining channel confirmations..."
  $BTC generatetoaddress 6 "$MINER_ADDR" >/dev/null
fi

log "waiting for channel to become active..."
for i in $(seq 1 30); do
  if $LNCLI_A listchannels 2>/dev/null | grep -q '"active": *true'; then
    log "channel ACTIVE"
    exit 0
  fi
  sleep 2
done
log "ERROR: channel did not become active"
exit 1
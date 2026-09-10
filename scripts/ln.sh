#!/usr/bin/env bash
# LND regtest wrapper for the Mostro docker stack.
#
# The regtest stack (docker/regtest) runs two LND nodes:
#   - alice (10009) — Mostro's own lightning node (do not touch)
#   - bob   (11009) — the user wallet for e2e tests
#
# Usage:
#   ln.sh addinvoice --amt=50000 --memo=buyer-payout        # print a bolt11 invoice
#   ln.sh payinvoice lnbcrt...                              # pay a hold/invoice
#   ln.sh lookupinvoice <r_hash>                            # invoice status
#   ln.sh getinfo
#   ln.sh bob|alice <any lncli subcommand...>               # raw lncli passthrough
#
# Overrides:
#   MOSTRO_LND_NODE=alice  (default bob)
set -euo pipefail

NODE="${MOSTRO_LND_NODE:-bob}"
case "$NODE" in
  bob) PORT=11009 ;;
  alice) PORT=10009 ;;
  *) echo "unknown LND node: $NODE (bob|alice)" >&2; exit 1 ;;
esac

lncli() {
  docker exec "mostro-regtest-lnd-$NODE" \
    lncli --network=regtest \
      --rpcserver="127.0.0.1:$PORT" \
      --tlscertpath=/home/lnd/.lnd/tls.cert \
      --macaroonpath=/home/lnd/.lnd/data/chain/bitcoin/regtest/admin.macaroon \
      "$@"
}

CMD="${1:-help}"
shift 2>/dev/null || true

case "$CMD" in
  help|-h|--help)
    cat <<'EOF'
LND regtest wrapper for the Mostro docker stack.

Usage:
  ln.sh addinvoice --amt=<sats> [--memo=<text>]   print a bolt11 invoice
  ln.sh payinvoice <bolt11>                       pay a hold/invoice
  ln.sh rebalance <sats>                          give bob outbound liquidity
  ln.sh lookupinvoice <r_hash>                    invoice status
  ln.sh getinfo | listchannels | listinvoices | listpayments | decodepayreq ...
  ln.sh bob|alice <any lncli subcommand...>       raw lncli passthrough (node = $NODE)

Overrides:
  MOSTRO_LND_NODE=alice  (default bob)
EOF
    ;;
  addinvoice)
    # Print just the bolt11 payment request.
    lncli addinvoice "$@" | jq -r .payment_request
    ;;
  payinvoice)
    # Non-interactive payment (skips the yes/no confirmation prompt).
    lncli payinvoice --force "$@"
    ;;
  rebalance)
    # Give bob outbound liquidity: alice pays a bob invoice for AMT sats.
    # Regtest quirk: Polar-funded channels often leave the user wallet with
    # zero outbound balance, so bob cannot pay hold invoices.
    AMT="${1:?usage: ln.sh rebalance <sats>}"
    if [ "$NODE" != "bob" ]; then
      echo "rebalance runs on the bob node" >&2; exit 1
    fi
    INV="$(docker exec mostro-regtest-lnd-bob lncli --network=regtest --rpcserver=127.0.0.1:11009 --tlscertpath=/home/lnd/.lnd/tls.cert --macaroonpath=/home/lnd/.lnd/data/chain/bitcoin/regtest/admin.macaroon addinvoice --amt="$AMT" | jq -r .payment_request)"
    echo "bob invoice for $AMT sats: ${INV:0:20}..."
    docker exec mostro-regtest-lnd-alice lncli --network=regtest --rpcserver=127.0.0.1:10009 --tlscertpath=/home/lnd/.lnd/tls.cert --macaroonpath=/home/lnd/.lnd/data/chain/bitcoin/regtest/admin.macaroon payinvoice --force "$INV" | tail -4
    ;;
  *)
    lncli "$CMD" "$@"
    ;;
esac
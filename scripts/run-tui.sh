#!/usr/bin/env bash
# Launch two Mostro TUI instances in tmux — one maker, one taker — against
# the local regtest stack (relay ws://localhost:7080).
#
# Left pane  = "seller" identity (its own sqlite DB + generated mnemonic)
# Right pane = "buyer"  identity (own DB + generated mnemonic)
#
# Env overrides (defaults match the regtest stack):
#   MOSTRO_RELAY            ws://localhost:7080
#   MOSTRO_SELLER_DB        tui/.seller.db
#   MOSTRO_BUYER_DB         tui/.buyer.db
set -euo pipefail

cd "$(dirname "$0")/.."

RELAY="${MOSTRO_RELAY:-ws://localhost:7080}"
SELLER_DB="${MOSTRO_SELLER_DB:-./tui/.seller.db}"
BUYER_DB="${MOSTRO_BUYER_DB:-./tui/.buyer.db}"

tmux has-session -t mostro-tui 2>/dev/null && tmux kill-session -t mostro-tui

tmux new-session -d -s mostro-tui -x 220 -y 50
tmux set-option -t mostro-tui pane-border-status top
tmux set-option -t mostro-tui pane-border-format "#{pane_index} #{pane_current_command} (#{pane_id})"
tmux split-window -h -t mostro-tui
tmux select-pane -t mostro-tui:0.0

tmux send-keys -t mostro-tui:0.0 "MOSTRO_RELAY=$RELAY MOSTRO_STORE=$SELLER_DB MOSTRO_MNEMONIC= npx tsx tui/main.ts" Enter
tmux send-keys -t mostro-tui:0.1 "MOSTRO_RELAY=$RELAY MOSTRO_STORE=$BUYER_DB MOSTRO_MNEMONIC= npx tsx tui/main.ts" Enter

tmux attach -t mostro-tui
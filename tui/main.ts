// Mostro TUI — dev harness for mostro-ts-client.
// Run: npx tsx tui/main.ts
//
// Tabs: Orders | Create | My Trades | Messages
// Keys: Tab/Shift+Tab switch, ↑↓ select, Enter act, Esc back, q quit.

import blessed from "blessed";
import { writeFileSync, readFileSync } from "node:fs";
import {
  MostroClient,
  generateMnemonic,
  deriveTradeKeys,
  parseChatAttachment,
  type SmallOrder,
  type Message,
} from "../src/protocol/index.js";
import { openNodeSqliteStore } from "../src/protocol/node-store.js";
import { infoFromRelay } from "../test/lib/relay.js";
import { SimplePool } from "nostr-tools/pool";

const RELAY = process.env.MOSTRO_RELAY ?? "ws://localhost:7080";
const RELAYS = [RELAY];

type TabName = "Orders" | "Create" | "My Trades" | "Messages";

async function main() {
  const pool = new SimplePool();
  const mostroPubkey = await infoFromRelay(pool, RELAY);
  pool.close(RELAYS);
  if (!mostroPubkey) {
    console.error(`no Mostro info event on ${RELAY}`);
    process.exit(1);
  }

  const store = openNodeSqliteStore(process.env.MOSTRO_STORE ?? "./tui/.mostro-tui.db");
  let mnemonic = process.env.MOSTRO_MNEMONIC;
  if (!mnemonic) {
    const user = await store.getUser();
    mnemonic = user?.mnemonic ?? generateMnemonic();
  }

  const blossomServers = process.env.MOSTRO_BLOSSOM?.split(",").map((s) => s.trim()).filter(Boolean);
  const client = new MostroClient({
    mnemonic,
    mostroPubkey,
    relays: RELAYS,
    store,
    ...(blossomServers && blossomServers.length > 0 ? { blossomServers } : {}),
  });
  await client.start();
  if (!(await store.getUser())) {
    await store.upsertUser({
      i0_pubkey: client.identity,
      mnemonic,
      last_trade_index: 0,
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  // ----- screen -----
  // `term: "xterm"` avoids xterm-256color's unparseable Setulc terminfo entry
  // that blessed dumps as a stack trace on startup.
  const screen = blessed.screen({ smartCSR: true, title: "Mostro TUI", term: "xterm" });
  const tabs: TabName[] = ["Orders", "Create", "My Trades", "Messages"];
  let activeTab: TabName = "Orders";
  const showTab = (t: TabName) => {
    activeTab = t;
    tabs.forEach((name) => tabBar.setContent(`${name === activeTab ? `{green-fg}${name}{/}` : name}`));
    ordersBox.hide();
    formBox.hide();
    tradesBox.hide();
    messagesBox.hide();
    if (t === "Orders") ordersBox.show();
    if (t === "Create") formBox.show();
    if (t === "My Trades") tradesBox.show();
    if (t === "Messages") messagesBox.show();
    if (t === "Create") renderForm();
    if (t === "My Trades") renderTrades();
    if (t === "Messages") renderMessages();
    renderStatus();
    screen.render();
  };

  // ----- layout -----
  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
  });
  const tabBar = blessed.box({
    parent: header,
    top: 0,
    left: 1,
    width: "100%",
    height: 1,
    tags: true,
    content: tabs.join(" "),
  });
  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
  });
  const body = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: "100%",
    height: "100%-4",
  });

  const log = (msg: string) => {
    logBox.pushLine(msg);
    logBox.scrollTo(logBox.getScrollHeight());
    screen.render();
  };

  // ----- hold invoice capture -----
  // Mostro sends the counterparty a bolt11 hold invoice to pay; dump the full
  // string to a file so it can be paid from a wallet (regtest: scripts/ln.sh).
  // The trade action popup surfaces the file + pay command in-context.
  const holdInvoiceFile = process.env.MOSTRO_HOLD_INVOICE_FILE ?? "./tui/hold-invoice.txt";
  const saveHoldInvoice = (invoice: string) => {
    try {
      writeFileSync(holdInvoiceFile, invoice);
      log(`hold invoice saved (${invoice.length} chars) → ${holdInvoiceFile}`);
      log(`pay it: scripts/ln.sh payinvoice "$(cat ${holdInvoiceFile})"`);
    } catch (e) {
      log(`could not save hold invoice: ${(e as Error).message}`);
    }
  };
  const holdInvoiceFor = (orderId: string): string | null => {
    const pr = client
      .getMessages(orderId)
      .map((h) => h.message.value.payload)
      .find((p) => p && p.variant === "payment_request");
    return pr && pr.value[1] ? pr.value[1] : null;
  };
  client.onAnyMessage((orderId, dm) => {
    const p = dm.message.value.payload;
    if (p && p.variant === "payment_request") {
      const invoice = p.value[1];
      if (!invoice) return;
      saveHoldInvoice(invoice);
      // Route the notice to the trade's action popup so the flow continues.
      if (orderId) {
        showTab("My Trades");
        openTradeActions(orderId);
      }
      return;
    }
    // State-change DM for the order shown in the open action popup → refresh
    // so the available actions follow the flow.
    if (actionPopup && actionOrderId === orderId) {
      refreshActionPopup();
    }
  });

  // ----- Orders tab -----
  const ordersBox = blessed.box({
    parent: body,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    border: { type: "line" },
    label: " Order Book ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
  });
  const orders: SmallOrder[] = [];
  let selectedIdx = 0;

  const renderBook = (list: SmallOrder[]) => {
    if (list !== orders) {
      orders.length = 0;
      orders.push(...list);
    }
    if (selectedIdx >= orders.length) selectedIdx = Math.max(0, orders.length - 1);
    const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
    const visibleLen = (s: string) => s.replace(/\{[^}]*\}/g, "").length;
    const vpad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visibleLen(s)));
    const inner = Number(screen.width) - 2;
    const fill = (line: string) => line + " ".repeat(Math.max(0, inner - visibleLen(line)));
    const head = fill(
      `${" ".repeat(2)}${pad("Kind", 6)}${pad("Order", 9)}${pad("Amount", 9)}${pad("Fiat", 5)}${pad("FiatAmt", 8)}${pad("Prem", 6)}${pad("Rating", 11)}${pad("Payment", 16)}${pad("Created", 12)}`,
    );
    const lines = orders.map((o, i) => {
      const sel = i === selectedIdx ? "{green-fg}{bold}> {/}" : "  ";
      const r = o.rating;
      const avg = r && r.total_reviews > 0 ? Math.min(5, Math.max(0, Math.round(r.total_rating / r.total_reviews))) : 0;
      const stars = avg > 0
        ? `{yellow-fg}${"★".repeat(avg)}${"☆".repeat(5 - avg)}{/}(${r!.total_reviews})`
        : "·";
      const created = o.created_at
        ? new Date(o.created_at * 1000).toISOString().slice(5, 16).replace("T", " ")
        : "";
      const kind = o.kind === "sell"
        ? `{yellow-fg}${pad("SELL", 6)}{/}`
        : `{cyan-fg}${pad("BUY", 6)}{/}`;
      const isRange = o.min_amount != null && o.max_amount != null;
      const starsCell = avg > 0 ? vpad(stars, 11) : pad("·", 11);
      const row =
        `${sel}${kind}${pad(o.id?.slice(0, 8) ?? "-", 9)}` +
        `${pad(isRange ? "range" : o.amount === 0 ? "market" : `${o.amount}sats`, 9)}${pad(o.fiat_code, 5)}` +
        `${pad(isRange ? `${o.min_amount}~${o.max_amount}` : `${o.fiat_amount}`, 8)}${pad(`${o.premium > 0 ? "+" : ""}${o.premium}%`, 6)}${starsCell}${pad(o.payment_method, 16)}${pad(created, 12)}`;
      return fill(row);
    });
    ordersBox.setContent([head, ...lines].join("\n"));
    screen.render();
  };
  client.onOrders(renderBook);

  // ----- Create tab -----
  const formBox = blessed.box({
    parent: body,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    border: { type: "line" },
    label: " Create New Order ",
    tags: true,
  });
  const formFields = {
    mode: { label: "Mode (fixed/range)", value: "fixed" },
    kind: { label: "Kind (buy/sell)", value: "sell" },
    fiatCode: { label: "Fiat code", value: "USD" },
    fiatAmount: { label: "Fiat amount", value: "100" },
    rangeMin: { label: "Range min", value: "100" },
    rangeMax: { label: "Range max", value: "400" },
    payment: { label: "Payment method", value: "SEPA" },
    premium: { label: "Premium %", value: "0" },
    days: { label: "Expiration days", value: "1" },
  } as const;
  type FormKey = keyof typeof formFields;
  const formKeys: FormKey[] = ["kind", "fiatCode", "mode", "fiatAmount", "rangeMin", "rangeMax", "premium", "payment", "days"];
  let formCursor = 0;
  const moveFormCursor = (delta: number) => {
    const vis = visibleFormKeys();
    const idx = Math.max(0, vis.indexOf(formKeys[formCursor]!));
    const next = vis[(idx + delta + vis.length) % vis.length]!;
    formCursor = formKeys.indexOf(next);
    renderForm();
  };

  const visibleFormKeys = (): FormKey[] => {
    const isRange = formFields.mode.value === "range";
    return formKeys.filter((k) => {
      if (k === "fiatAmount") return !isRange;
      if (k === "rangeMin" || k === "rangeMax") return isRange;
      return true;
    });
  };

  const renderForm = () => {
    const lines = ["Enter submit | ↑↓ field | q back", ""];
    visibleFormKeys().forEach((k) => {
      const f = formFields[k];
      const sel = k === formKeys[formCursor] ? "{green-fg}>{/} " : "  ";
      const edit = k === formKeys[formCursor] ? `{bold}${f.value}{/}` : f.value;
      lines.push(`${sel}${f.label}: ${edit}`);
    });
    formBox.setContent(lines.join("\n"));
    screen.render();
  };

  // ----- My Trades tab -----
  const tradesBox = blessed.box({
    parent: body,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    border: { type: "line" },
    label: " My Trades ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
  });
  let tradesIdx = 0;
  let tradesList: Awaited<ReturnType<typeof store.getActiveOrders>> = [];

  const renderTrades = async () => {
    const { TERMINAL_DM_STATUSES } = await import("../src/protocol/statusSets.js");
    tradesList = await store.getActiveOrders(TERMINAL_DM_STATUSES);
    if (tradesIdx >= tradesList.length) tradesIdx = Math.max(0, tradesList.length - 1);
    const lines = tradesList.map((t, i) => {
      const sel = i === tradesIdx ? "{green-fg}{bold}> {/}" : "  ";
      const role = t.is_mine === 1 ? "maker" : "taker";
      return `${sel}${t.id.slice(0, 8)} {green-fg}${t.status ?? "?"}{/} (${role}) ${t.kind ?? "?"} ${t.fiat_amount} ${t.fiat_code}`;
    });
    tradesBox.setContent(lines.join("\n"));
    screen.render();
  };

  // ----- Messages tab -----
  const messagesBox = blessed.box({
    parent: body,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    border: { type: "line" },
    label: " Messages ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
  });
  let msgOrderId: string | null = null;
  const renderMessages = () => {
    if (!msgOrderId) {
      messagesBox.setContent("Select an order in My Trades (Enter) to view its DMs.");
      screen.render();
      return;
    }
    const history = client.getMessages(msgOrderId);
    const lines: string[] = [];
    if (history.length === 0) {
      lines.push(`order ${msgOrderId.slice(0, 8)}: no DMs yet`);
    }
    for (const { timestamp, message } of history) {
      const k = message.value;
      lines.push(
        `{cyan-fg}[${new Date(timestamp * 1000).toISOString().slice(11, 19)}]{/} ${k.action}`,
      );
      const p = k.payload;
      if (p && p.variant === "payment_request") {
        lines.push(`  invoice: ${p.value[1].slice(0, 40)}...`);
      } else if (p && p.variant === "order") {
        lines.push(`  status: ${p.value.status ?? "?"} amt: ${p.value.amount}`);
      }
    }
    messagesBox.setContent(lines.join("\n"));
    messagesBox.scrollTo(messagesBox.getScrollHeight());
    screen.render();
  };

  // ----- Log -----
  const logBox = blessed.box({
    parent: screen,
    bottom: 1,
    left: 0,
    width: "100%",
    height: "25%",
    border: { type: "line" },
    label: " Log ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
  });

  const renderStatus = () => {
    statusBar.setContent(
      `{green-fg}${activeTab}{/} | ${client.identity.slice(0, 12)} | ${RELAY} | ${mostroPubkey.slice(0, 8)}`,
    );
  };

  // ----- range take: ask the taker for the fiat amount -----
  const showRangeTakeInput = (order: SmallOrder) => {
    const box = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: 60,
      height: 7,
      border: { type: "line" },
      label: " Range take amount ",
      tags: true,
      content: `Range: ${order.min_amount}~${order.max_amount} ${order.fiat_code}\nAmount to take:`,
    });
    const input = blessed.textbox({
      parent: box,
      top: 3,
      left: 1,
      width: 54,
      height: 1,
    });
    invoicePrompt = box;
    input.focus();
    input.readInput(() => {
      const amount = Number.parseInt(input.getValue().trim(), 10);
      box.destroy();
      invoicePrompt = null;
      screen.render();
      if (!amount || amount < (order.min_amount ?? 0) || amount > (order.max_amount ?? 0)) {
        log(`invalid range take amount (${order.min_amount}~${order.max_amount})`);
        return;
      }
      showConfirm(
        `Take ${order.kind} ${amount} ${order.fiat_code} from range?\n` +
          `${order.amount === 0 ? "market" : order.amount} sats [${order.payment_method}]`,
        () => {
          log(`taking ${order.kind} ${amount} ${order.fiat_code}...`);
          client
            .takeOrder(order, { amount })
            .then((res) => {
              log(`take → next=${res.next}${res.amount != null ? ` amt=${res.amount}` : ""}`);
              if (res.next === "add-invoice") {
                showInvoiceInput(order.id!, res.amount ?? undefined);
              } else if (res.next === "hold-invoice" && res.invoice) {
                saveHoldInvoice(res.invoice);
                openTradeActions(order.id!);
              }
              return renderTrades();
            })
            .catch((e: Error) => log(`take failed: ${e.message}`));
        },
      );
    });
    screen.render();
  };

  // ----- invoice popup (take → add-invoice) -----
  let invoicePrompt: blessed.Widgets.BoxElement | null = null;
  const showInvoiceInput = (orderId: string, amount?: number) => {
    const box = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: 60,
      height: 7,
      border: { type: "line" },
      label: " Buyer invoice required ",
      tags: true,
      content: `Amount: ${amount ?? "market"}\nPaste bolt11 invoice:`,
    });
    const input = blessed.textbox({
      parent: box,
      top: 3,
      left: 1,
      width: 54,
      height: 1,
    });
    invoicePrompt = box;
    input.focus();
    input.readInput(() => {
      const invoice = input.getValue().trim();
      if (invoice) {
        client
          .submitInvoice(orderId, invoice)
          .then(() => log(`invoice submitted for ${orderId.slice(0, 8)}`))
          .catch((e: Error) => log(`invoice failed: ${e.message}`))
          .finally(() => {
            box.destroy();
            invoicePrompt = null;
            renderTrades().then(() => openTradeActions(orderId));
          });
      } else {
        box.destroy();
        invoicePrompt = null;
        // Esc from invoice input returns to the trade actions popup.
        openTradeActions(orderId);
      }
    });
    screen.render();
  };

  // ----- keys -----
  let confirmActive = false;
  let confirmYes: (() => void) | null = null;
  let confirmBox: blessed.Widgets.BoxElement | null = null;
  const showConfirm = (text: string, onYes: () => void) => {
    const lines = text.split("\n").length + 4;
    const box = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: 60,
      height: Math.max(lines, 6),
      border: { type: "line" },
      label: " Confirm ",
      tags: true,
      content: `${text}\n\n{yellow-fg}(y) Yes (n) No{/}`,
    });
    confirmBox = box;
    confirmActive = true;
    confirmYes = onYes;
    screen.render();
  };
  const closeConfirm = () => {
    confirmActive = false;
    confirmYes = null;
    confirmBox?.destroy();
    confirmBox = null;
    screen.render();
  };

  // ----- trade action popup (My Trades: select trade → act) -----
  let actionPopup: blessed.Widgets.BoxElement | null = null;
  let actionCursor = 0;
  let actionOrderId: string | null = null;
  let actionItems: Array<{ label: string; run: () => void }> = [];

  const closeActionPopup = () => {
    actionPopup?.destroy();
    actionPopup = null;
    actionOrderId = null;
    actionItems = [];
    actionCursor = 0;
    screen.render();
  };

  const renderActionPopup = () => {
    if (!actionPopup || !actionOrderId) return;
    const orderId = actionOrderId;
    const trade = tradesList.find((t) => t.id === orderId);
    const role = trade ? (trade.is_mine === 1 ? "maker" : "taker") : "?";
    const lines: string[] = [];
    lines.push(`{bold}${orderId.slice(0, 8)}{/} {green-fg}${trade?.status ?? "?"}{/} (${role})`);
    const pk = counterpartTradePubkey(orderId);
    const cr = pk ? ratingCache.get(pk) : undefined;
    if (cr) {
      const stars = "★".repeat(Math.min(5, Math.max(0, Number.parseInt(cr.rating, 10) || 0)));
      lines.push(`{cyan-fg}counterpart ${stars || "·"} (${cr.reviews} reviews){/}`);
    }
    if (holdInvoiceFor(orderId)) {
      lines.push(`{yellow-fg}hold invoice → ${holdInvoiceFile}{/}`);
      lines.push(`{yellow-fg}pay: scripts/ln.sh payinvoice "$(cat ${holdInvoiceFile})"{/}`);
      lines.push("");
    }
    if (actionItems.length === 0) {
      lines.push("  (no actionable step)");
    }
    actionItems.forEach((item, i) => {
      const sel = i === actionCursor ? "{green-fg}{bold}> {/}" : "  ";
      lines.push(`${sel}${item.label}`);
    });
    actionPopup.setContent(lines.join("\n"));
    actionPopup.height = Math.min(lines.length + 2, screen.height - 6);
    screen.render();
  };

  const buildActions = async (orderId: string): Promise<Array<{ label: string; run: () => void }>> => {
    const t = tradesList.find((x) => x.id === orderId);
    const items: Array<{ label: string; run: () => void }> = [];
    const state = (t?.status ?? "").toLowerCase();
    const isBuyer = t ? (t.kind === "sell" ? t.is_mine === 0 : t.is_mine === 1) : false;

    if (isBuyer && t?.kind === "sell" && ["waiting-buyer-invoice", "add-invoice", "pending"].includes(state)) {
      items.push({
        label: "Submit buyer invoice",
        run: () => {
          closeActionPopup();
          showInvoiceInput(orderId, t?.amount ?? undefined);
        },
      });
    }
    if (isBuyer && ["holding-invoice", "active"].includes(state)) {
      items.push({
        label: "FiatSent",
        run: () => confirmAndSend(orderId, "fiat-sent"),
      });
    }
    if (!isBuyer && t && state === "fiat-sent") {
      items.push({
        label: "Release",
        run: () => confirmAndSend(orderId, "release"),
      });
    }
    if (state === "success" || (state === "settled-hold-invoice" && !isBuyer)) {
      if (hasRated(orderId)) {
        items.push({ label: "✓ Rated", run: () => {} });
      } else {
        items.push({
          label: "Rate counterpart",
          run: () => showRatePicker(orderId),
        });
      }
    }
    if (
      ["pending", "waiting-taker-bond", "waiting-buyer-invoice", "waiting-payment", "active", "holding-invoice", "in-progress"].includes(state)
    ) {
      items.push({
        label: "Cancel order",
        run: () => confirmCancel(orderId),
      });
    }
    if (await client.canOrderChat(orderId)) {
      items.push({
        label: "Peer chat",
        run: () => showChat(orderId, "peer"),
      });
    }
    if (tradesList.find((x) => x.id === orderId)?.solver_pubkey) {
      items.push({
        label: "Solver chat",
        run: () => showChat(orderId, "solver"),
      });
    }
    items.push({
      label: "View messages",
      run: () => {
        closeActionPopup();
        msgOrderId = orderId;
        showTab("Messages");
        renderMessages();
      },
    });
    return items;
  };

  const openTradeActions = async (orderId: string) => {
    closeActionPopup();
    await renderTrades();
    actionOrderId = orderId;
    actionCursor = 0;
    actionItems = await buildActions(orderId);
    actionPopup = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: 76,
      height: 8,
      border: { type: "line" },
      label: " Trade actions ",
      tags: true,
    });
    renderActionPopup();
    loadCounterpartRating(orderId);
  };

  const refreshActionPopup = async () => {
    if (!actionPopup || !actionOrderId) return;
    await renderTrades();
    actionItems = await buildActions(actionOrderId);
    actionCursor = Math.min(actionCursor, Math.max(0, actionItems.length - 1));
    renderActionPopup();
  };

  const confirmAndSend = (orderId: string, action: "fiat-sent" | "release") => {
    closeActionPopup();
    showConfirm(`${action} for ${orderId.slice(0, 8)}?`, () => {
      client
        .sendTradeAction(orderId, action)
        .then(async () => {
          log(`${action} sent for ${orderId.slice(0, 8)}`);
          await openTradeActions(orderId);
        })
        .catch((e: Error) => log(`${action} failed: ${e.message}`));
    });
  };

  const confirmCancel = (orderId: string) => {
    closeActionPopup();
    showConfirm(`Cancel order ${orderId.slice(0, 8)}?`, () => {
      client
        .cancelOrder(orderId)
        .then(async () => {
          log(`cancel sent for ${orderId.slice(0, 8)}`);
          await openTradeActions(orderId);
        })
        .catch((e: Error) => log(`cancel failed: ${e.message}`));
    });
  };

  // ----- rate counterpart popup (1..=5) -----
  let ratePopup: blessed.Widgets.BoxElement | null = null;
  let rateOrderId: string | null = null;
  let rateValue = 5;
  const renderRatePicker = () => {
    if (!ratePopup) {
      ratePopup = blessed.box({
        parent: screen,
        top: "center",
        left: "center",
        width: 52,
        height: 9,
        border: { type: "line" },
        label: " Rate counterpart ",
        tags: true,
      });
    }
    const stars = "★".repeat(rateValue) + "☆".repeat(5 - rateValue);
    ratePopup.setContent(
      `How was the trade?\n\n  {yellow-fg}${stars}{/}\n\n  ↑↓ or 1-5 pick · Enter send · Esc cancel`,
    );
    screen.render();
  };
  const closeRatePicker = () => {
    ratePopup?.destroy();
    ratePopup = null;
    rateOrderId = null;
    screen.render();
  };
  const showRatePicker = (orderId: string) => {
    closeActionPopup();
    rateOrderId = orderId;
    rateValue = 5;
    renderRatePicker();
  };

  // ----- peer / solver chat popup -----
  let chatPrompt: blessed.Widgets.BoxElement | null = null;
  const showChat = (orderId: string, mode: "peer" | "solver") => {
    closeActionPopup();
    chatPrompt?.destroy();
    let closed = false;
    const box = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: 90,
      height: 24,
      border: { type: "line" },
      label: mode === "peer" ? " Peer chat " : " Solver chat ",
      tags: true,
      scrollable: true,
      alwaysScroll: true,
    });
    chatPrompt = box;
    const input = blessed.textbox({
      parent: box,
      bottom: 1,
      left: 1,
      width: 86,
      height: 1,
    });
    const renderChat = () => {
      if (closed) return;
      const history = mode === "peer" ? client.getOrderChat(orderId) : client.getDisputeChat(orderId);
      const t = tradesList.find((x) => x.id === orderId);
      const myTradePub = t?.trade_index != null ? deriveTradeKeys(mnemonic, t.trade_index).pubkey : client.identity;
      const peerLabel = mode === "solver" ? "solver" : "peer";
      const body = history.length
        ? history
            .map((m) => {
              const mine = m.sender === myTradePub;
              const who = mine ? "{green-fg}(me){/}" : `{yellow-fg}(${peerLabel}){/}`;
              const time = new Date(m.created_at * 1000).toISOString().slice(11, 19);
              const att = parseChatAttachment(m.content);
              const content = att ? `{magenta-fg}📎 ${att.type === "image_encrypted" ? "image" : "file"}: ${att.filename}{/}` : m.content;
              return `{cyan-fg}(${time}){/} ${who} ${content}`;
            })
            .join("\n")
        : "(no messages — type below, Enter sends, Esc closes)";
      box.setContent(`${body}\n`);
      box.scrollTo(box.getScrollHeight());
      screen.render();
    };
    const read = () => {
      input.readInput(() => {
        const text = input.getValue().trim();
        if (!text) {
          closed = true;
          box.destroy();
          chatPrompt = null;
          // Esc from chat returns to the trade actions popup.
          openTradeActions(orderId);
          return;
        }
        input.clearValue();
        let send: Promise<unknown>;
        if (mode === "peer" && text.startsWith("/file ")) {
          const path = text.slice(6).trim();
          try {
            const data = readFileSync(path);
            send = client
              .sendOrderChatAttachment(orderId, { filename: path.split("/").pop() ?? "attachment", data })
              .then((url) => log(`attachment uploaded: ${url}`));
          } catch (e) {
            send = Promise.reject(e);
          }
        } else if (mode === "peer" && text.startsWith("/save ")) {
          const out = text.slice(6).trim();
          const att = client
            .getOrderChat(orderId)
            .map((m) => parseChatAttachment(m.content))
            .filter((a): a is NonNullable<typeof a> => a !== null)
            .pop();
          send = att
            ? client.downloadOrderChatAttachment(orderId, att).then((data) => {
                writeFileSync(out, data);
                log(`attachment saved: ${out} (${data.length} bytes)`);
              })
            : Promise.reject(new Error("no attachment in this chat"));
        } else {
          send = mode === "peer" ? client.sendOrderChat(orderId, text) : client.sendDisputeChat(orderId, text);
        }
        Promise.resolve(send)
          .then(() => renderChat())
          .catch((e: Error) => log(`chat failed: ${e.message}`))
          .finally(() => read());
      });
    };
    client.onOrderChat(orderId, () => renderChat());
    client.onDisputeChat(orderId, () => renderChat());
    renderChat();
    input.focus();
    read();
  };
  const sendRate = () => {
    const orderId = rateOrderId;
    if (!orderId) return;
    closeRatePicker();
    client
      .rateUser(orderId, rateValue)
      .then(async () => {
        log(`rated ${orderId.slice(0, 8)}: ${rateValue}/5`);
        ratedOrders.add(orderId);
        await openTradeActions(orderId);
      })
      .catch((e: Error) => log(`rate failed: ${e.message}`));
  };

  // ----- rating state (Phase 2) -----
  const ratedOrders = new Set<string>();
  const hasRated = (orderId: string): boolean => {
    if (ratedOrders.has(orderId)) return true;
    return client
      .getMessages(orderId)
      .some((dm) => dm.message.value.action === "rate-received");
  };
  // Counterpart rating (kind 38384, d-tag = their trade pubkey) for the popup.
  const ratingPool = new SimplePool();
  const ratingCache = new Map<string, { rating: string; reviews: string } | null>();
  const counterpartTradePubkey = (orderId: string): string | null => {
    const t = tradesList.find((x) => x.id === orderId);
    if (!t || t.trade_index == null) return null;
    const myTrade = deriveTradeKeys(mnemonic, t.trade_index).pubkey;
    for (const dm of client.getMessages(orderId)) {
      const p = dm.message.value.payload;
      if (p && p.variant === "order") {
        const o = p.value;
        if (o.buyer_trade_pubkey && o.buyer_trade_pubkey !== myTrade) return o.buyer_trade_pubkey;
        if (o.seller_trade_pubkey && o.seller_trade_pubkey !== myTrade) return o.seller_trade_pubkey;
      }
    }
    return null;
  };
  const loadCounterpartRating = async (orderId: string) => {
    const pk = counterpartTradePubkey(orderId);
    if (!pk || ratingCache.has(pk)) return;
    try {
      const evs = await ratingPool.querySync(
        [RELAY],
        { kinds: [38384], authors: [mostroPubkey], "#d": [pk], limit: 1 },
      );
      const ev = evs[0];
      const tags: Record<string, string> = {};
      for (const [k, v] of ev?.tags ?? []) {
        if (k !== "d" && k !== "z" && k !== "expiration") tags[k] = v;
      }
      ratingCache.set(pk, ev ? { rating: tags.total_rating ?? "?", reviews: tags.total_reviews ?? "0" } : null);
    } catch {
      ratingCache.set(pk, null);
    }
    renderActionPopup();
  };

  screen.key(["y"], () => {
    if (!confirmActive) return;
    const fn = confirmYes;
    closeConfirm();
    fn?.();
  });
  screen.key(["n", "escape"], () => {
    if (ratePopup) {
      const oid = rateOrderId;
      closeRatePicker();
      if (oid) openTradeActions(oid);
    }
    if (actionPopup) closeActionPopup();
    if (confirmActive) closeConfirm();
  });

  screen.key(["q", "C-c"], () => {
    client.stop().finally(() => process.exit(0));
  });
  // Factory reset: wipe local session data (restart to reset the running state).
  screen.key(["S-w"], () => {
    if (confirmActive || actionPopup || invoicePrompt) return;
    showConfirm("Wipe ALL local session data (orders, chats)?", () => {
      store
        .wipe()
        .then(() => {
          log("session wiped — restart the TUI to reset in-memory state");
          orders.length = 0;
          tradesList = [];
          renderBook(orders);
          renderTrades();
        })
        .catch((e: Error) => log(`wipe failed: ${e.message}`));
    });
  });
  screen.key(["tab", "C-i"], () => {
    if (actionPopup) closeActionPopup();
    showTab(tabs[(tabs.indexOf(activeTab) + 1) % tabs.length]!);
  });
  screen.key(["S-tab"], () => {
    if (actionPopup) closeActionPopup();
    showTab(tabs[(tabs.indexOf(activeTab) - 1 + tabs.length) % tabs.length]!);
  });

  // Orders / My Trades / Create navigation (↑↓)
  screen.key(["up"], () => {
    if (ratePopup) {
      rateValue = Math.max(1, rateValue - 1);
      renderRatePicker();
    } else if (actionPopup) {
      actionCursor = Math.max(0, actionCursor - 1);
      renderActionPopup();
    } else if (activeTab === "Orders") {
      selectedIdx = Math.max(0, selectedIdx - 1);
      renderBook(orders);
    } else if (activeTab === "My Trades") {
      tradesIdx = Math.max(0, tradesIdx - 1);
      renderTrades();
    } else if (activeTab === "Create") {
      moveFormCursor(-1);
    }
  });
  screen.key(["down"], () => {
    if (ratePopup) {
      rateValue = Math.min(5, rateValue + 1);
      renderRatePicker();
    } else if (actionPopup) {
      actionCursor = Math.min(actionItems.length - 1, actionCursor + 1);
      renderActionPopup();
    } else if (activeTab === "Orders") {
      selectedIdx++;
      renderBook(orders);
    } else if (activeTab === "My Trades") {
      tradesIdx++;
      renderTrades();
    } else if (activeTab === "Create") {
      moveFormCursor(1);
    }
  });
  screen.key(["enter"], () => {
    if (ratePopup) {
      sendRate();
      return;
    }
    if (actionPopup) {
      const item = actionItems[actionCursor];
      if (item) item.run();
      return;
    }
    if (confirmActive || invoicePrompt) return;
    if (activeTab === "Orders") {
      const order = orders[selectedIdx];
      if (!order) return;
      // Range order: ask the taker for the fiat amount first.
      if (order.min_amount != null && order.max_amount != null) {
        showRangeTakeInput(order);
        return;
      }
      // mostrix flow: confirm before taking (YES/NO overlay).
      const r = order.rating;
      const avg = r && r.total_reviews > 0 ? Math.min(5, Math.max(0, Math.round(r.total_rating / r.total_reviews))) : 0;
      const stars = avg > 0
        ? ` {yellow-fg}${"★".repeat(avg)}${"☆".repeat(5 - avg)}{/}(${r!.total_reviews})`
        : "";
      showConfirm(
        `Take ${order.kind} ${order.fiat_amount} ${order.fiat_code}?\n` +
          `${order.amount === 0 ? "market" : order.amount} sats${stars} [${order.payment_method}]`,
        () => {
          log(`taking ${order.kind} ${order.fiat_amount} ${order.fiat_code}...`);
          client
            .takeOrder(order)
            .then((res) => {
              log(`take → next=${res.next}${res.amount != null ? ` amt=${res.amount}` : ""}`);
              if (res.next === "add-invoice") {
                showInvoiceInput(order.id!, res.amount ?? undefined);
              } else if (res.next === "hold-invoice" && res.invoice) {
                saveHoldInvoice(res.invoice);
                openTradeActions(order.id!);
              }
              return renderTrades();
            })
            .catch((e: Error) => log(`take failed: ${e.message}`));
        },
      );
    }
    if (activeTab === "My Trades") {
      const t = tradesList[tradesIdx];
      if (t) {
        log(`trade actions for ${t.id.slice(0, 8)}`);
        openTradeActions(t.id);
      }
    }
    if (activeTab === "Create") {
      // mostrix flow: confirm order summary before submitting.
      const f = formFields;
      const rm = Number.parseInt(f.rangeMin.value, 10) || 0;
      const rx = Number.parseInt(f.rangeMax.value, 10) || 0;
      const amt = f.mode.value === "range" ? `${rm}-${rx}` : f.fiatAmount.value;
      showConfirm(
        `Create ${f.kind.value} ${amt} ${f.fiatCode.value}?\n` +
          `${f.payment.value} · ${f.premium.value}% premium · ${f.days.value}d`,
        () => submitForm(),
      );
    }
  });

  // Create form
  screen.key(["left", "right", " "], () => {
    if (confirmActive || actionPopup || invoicePrompt) return;
    if (activeTab === "Create") {
      const k = formKeys[formCursor]!;
      if (k === "mode") {
        formFields.mode.value = formFields.mode.value === "fixed" ? "range" : "fixed";
        if (!visibleFormKeys().includes(formKeys[formCursor]!)) {
          formCursor = formKeys.indexOf("mode");
        }
      } else if (k === "kind") {
        formFields.kind.value = formFields.kind.value === "sell" ? "buy" : "sell";
      } else if (k === "fiatCode") {
        formFields.fiatCode.value = formFields.fiatCode.value === "USD" ? "EUR" : "USD";
      }
      renderForm();
    }
  });
  // Raw character input: `screen.key(["character"])` never fires in blessed
  // (no such special key), so route printable keys through keypress. Digit
  // keys arrive with `key.name === undefined` (only `key.full`/`ch` set).
  screen.on("keypress", (ch, key) => {
    if (!key || key.ctrl) return;
    const name = key.name;
    const char = (ch ?? name ?? "").toString();
    if (ratePopup) {
      const n = Number.parseInt(char, 10);
      if (n >= 1 && n <= 5) {
        rateValue = n;
        renderRatePicker();
      }
      return;
    }
    if (confirmActive || actionPopup || invoicePrompt) return;
    if (activeTab === "Create") {
      const k = formKeys[formCursor]!;
      if (k === "kind") return;
      const f = formFields[k];
      if (name === "backspace") {
        f.value = f.value.slice(0, -1);
      } else if (char.length === 1 && /^[0-9a-zA-Z@. -]$/.test(char)) {
        f.value += char;
      }
      renderForm();
    }
  });

  const submitForm = () => {
    const f = formFields;
    const kind = f.kind.value === "buy" ? "buy" : "sell";
    const fiatAmount = Number.parseInt(f.fiatAmount.value, 10) || 0;
    const premium = Number.parseInt(f.premium.value, 10) || 0;
    const rangeMin = Number.parseInt(f.rangeMin.value, 10) || 0;
    const rangeMax = Number.parseInt(f.rangeMax.value, 10) || 0;
    const isRange = f.mode.value === "range";
    log(`creating ${kind} ${isRange ? `${rangeMin}-${rangeMax}` : fiatAmount} ${f.fiatCode.value} (premium ${premium}%)...`);
    client
      .createOrder({
        kind,
        fiatAmount,
        fiatCode: f.fiatCode.value,
        paymentMethod: f.payment.value,
        expirationDays: Number.parseInt(f.days.value, 10) || 1,
        premium,
        ...(isRange ? { minAmount: rangeMin, maxAmount: rangeMax } : {}),
      })
      .then((res) => {
        log(`created ${res.orderId.slice(0, 8)} status=${res.status}`);
        return renderTrades();
      })
      .catch((e: Error) => log(`create failed: ${e.message}`));
  };

  // ----- boot -----
  showTab("Orders");
  // Explicit initial fetch: start()'s internal poller ran before onOrders was
  // registered, so pull the book now and on 'r'.
  client.fetchOrders().then(renderBook).catch(() => {});
  screen.key(["r"], () => {
    client.fetchOrders().then(renderBook).catch(() => log("refresh failed"));
    renderTrades();
  });
  log(`connected to ${RELAY}`);
  log(`mostro: ${mostroPubkey.slice(0, 16)}...`);
  log("Tab switch | ↑↓ select | Enter: act/actions popup | Esc back | r refresh | q quit");
  screen.render();
}

main().catch((e) => {
  console.error("TUI crashed:", e);
  process.exit(1);
});
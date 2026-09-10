// Mostro TUI — dev harness for mostro-ts-client.
// Run: npx tsx tui/main.ts
//
// Tabs: Orders | Create | My Trades | Messages
// Keys: Tab/Shift+Tab switch, ↑↓ select, Enter act, Esc back, q quit.

import blessed from "blessed";
import { writeFileSync } from "node:fs";
import {
  MostroClient,
  generateMnemonic,
  deriveTradeKeys,
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

  const client = new MostroClient({ mnemonic, mostroPubkey, relays: RELAYS, store });
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
    const lines = orders.map((o, i) => {
      const sel = i === selectedIdx ? "{green-fg}{bold}> {/}" : "  ";
      const kind = o.kind === "sell" ? "{yellow-fg}SELL{/}" : "{cyan-fg}BUY{/}";
      return `${sel}${kind} ${o.fiat_amount} ${o.fiat_code} @ ${o.amount === 0 ? "market" : o.amount}sats [${o.payment_method}] ${o.id?.slice(0, 8)}`;
    });
    ordersBox.setContent(lines.join("\n"));
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
    kind: { label: "Kind (buy/sell)", value: "sell" },
    fiatCode: { label: "Fiat code", value: "USD" },
    fiatAmount: { label: "Fiat amount", value: "100" },
    payment: { label: "Payment method", value: "SEPA" },
    days: { label: "Expiration days", value: "1" },
  } as const;
  type FormKey = keyof typeof formFields;
  const formKeys: FormKey[] = ["kind", "fiatCode", "fiatAmount", "payment", "days"];
  let formCursor = 0;

  const renderForm = () => {
    const lines = ["Enter submit | ↑↓ field | q back", ""];
    formKeys.forEach((k, i) => {
      const f = formFields[k];
      const sel = i === formCursor ? "{green-fg}>{/} " : "  ";
      const edit = i === formCursor ? `{bold}${f.value}{/}` : f.value;
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
        screen.render();
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

  const buildActions = (orderId: string): Array<{ label: string; run: () => void }> => {
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
    actionItems = buildActions(orderId);
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
    actionItems = buildActions(actionOrderId);
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
    if (ratePopup) closeRatePicker();
    if (actionPopup) closeActionPopup();
    if (confirmActive) closeConfirm();
  });

  screen.key(["q", "C-c"], () => {
    client.stop().finally(() => process.exit(0));
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
      formCursor = (formCursor - 1 + formKeys.length) % formKeys.length;
      renderForm();
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
      formCursor = (formCursor + 1) % formKeys.length;
      renderForm();
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
      // mostrix flow: confirm before taking (YES/NO overlay).
      showConfirm(
        `Take ${order.kind} ${order.fiat_amount} ${order.fiat_code}?\n` +
          `${order.amount === 0 ? "market" : order.amount} sats [${order.payment_method}]`,
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
      showConfirm(
        `Create ${f.kind.value} ${f.fiatAmount.value} ${f.fiatCode.value}?\n` +
          `${f.payment.value} · ${f.days.value}d`,
        () => submitForm(),
      );
    }
  });

  // Create form
  screen.key(["left", "right", " "], () => {
    if (confirmActive || actionPopup || invoicePrompt) return;
    if (activeTab === "Create") {
      const k = formKeys[formCursor]!;
      if (k === "kind") {
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
    log(`creating ${kind} ${fiatAmount} ${f.fiatCode.value}...`);
    client
      .createOrder({
        kind,
        fiatAmount,
        fiatCode: f.fiatCode.value,
        paymentMethod: f.payment.value,
        expirationDays: Number.parseInt(f.days.value, 10) || 1,
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
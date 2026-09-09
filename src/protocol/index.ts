// Mostro protocol types — Phase 1 port from mostro-core 0.14.3.

export {
  MAX_RATING,
  MIN_RATING,
  NOSTR_ORDER_EVENT_KIND,
  NOSTR_RATING_EVENT_KIND,
  NOSTR_INFO_EVENT_KIND,
  NOSTR_DISPUTE_EVENT_KIND,
  PROTOCOL_VER,
} from "./constants.js";

export { Action, actionFromString, actionToString } from "./action.js";

export { Kind, kindFromString, kindToString } from "./kind.js";

export { Status, statusFromString, statusToString } from "./status.js";

export { CantDoReason, cantDoReasonFromString } from "./cantDo.js";

export { DisputeStatus, disputeStatusFromString } from "./dispute.js";
export type { Dispute, SolverDisputeInfo, UserInfo } from "./dispute.js";

export { Transport, transportFromString, transportToString, transportEventKind, transportProtocolVersion } from "./transport.js";

export { newRating, updateRating } from "./user.js";
export type { Rating, User, UserInfo as UserInfoFromUser } from "./user.js";

export {
  deriveKeysFromMnemonic,
  deriveIdentityKeys,
  deriveTradeKeys,
  reserveNextTradeIndex,
  generateMnemonic,
  validateMnemonic,
  identityNsecFromMnemonic,
  nsecFromSecret,
} from "./keys.js";
export type { DerivedKeys } from "./keys.js";

export {
  TERMINAL_DM_STATUSES,
  TERMINAL_ORDER_HISTORY_STATUSES,
  ORDER_HISTORY_BULK_DELETE_STATUSES,
} from "./statusSets.js";

export {
  newRequestId,
  buildNewOrder,
  buildTradeMessage,
  buildTakeOrderPayload,
  takeActionForOrder,
  handleNewOrderResponse,
  handleTakeOrderResponse,
  CantDoError,
} from "./flow.js";
export type {
  NewOrderInput,
  NewOrderOutcome,
  NewOrderResponse,
  TakeOrderResponse,
} from "./flow.js";

export { newSmallOrder, satsAmount, checkFiatAmount, checkAmount, checkZeroAmountWithPremium, checkRangeOrderLimits, checkFiatCurrency, isRangeOrder } from "./order.js";
export type { Order, SmallOrder } from "./order.js";

export {
  newPeer,
  newMessageKind,
  newOrderMessage,
  newDisputeMessage,
  newRestoreMessage,
  cantDoMessage,
  newDmMessage,
  getInnerMessageKind,
  innerAction,
} from "./message.js";
export type {
  Peer,
  PaymentFailedInfo,
  RestoredOrdersInfo,
  DisputeInitiator,
  RestoredDisputesInfo,
  RestoreSessionInfo,
  BondResolution,
  BondPayoutRequest,
  CashuLockProof,
  CashuProofSignature,
  Payload,
  MessageKind,
  Message,
} from "./message.js";

export {
  verifyMessageKind,
  verifyMessage,
  getNextTradeKey,
  getRating,
  getOrder,
  getPaymentRequest,
  getAmount,
  hasTradeIndex,
} from "./verify.js";

export {
  serializeMessage,
  deserializeMessage,
  messageToJson,
  messageFromJson,
  messageKindToJson,
  messageKindFromJson,
  payloadToJson,
  payloadFromJson,
  smallOrderToJson,
} from "./wire.js";

export {
  messageDigest,
  signMessage,
  verifyMessageSignature,
  wrapMessageNip44,
  unwrapMessageNip44,
  pubkeyFromSecret,
} from "./transport.js";
export type { WrapOptions, UnwrappedMessage } from "./transport.js";

export { sendDm, DmRouter, filterProtocolDmFromMostro, FETCH_EVENTS_TIMEOUT_MS, replayTradeDms } from "./dmRouter.js";
export type { DmSendParams, DmRouterOptions, ReplayedDm } from "./dmRouter.js";

export {
  isTerminalTradeStatus,
  statusPhaseRankForActor,
  shouldApplyStatusTransition,
  shouldStrictlyAdvanceStatus,
  inferredStatusFromTradeAction,
  mapActionToStatus,
  parseStatus,
  parseKind,
} from "./stateMachine.js";

export {
  MOSTRO_INSTANCE_INFO_KIND,
  emptyMostroInstanceInfo,
  isInstanceInfoStale,
  mostroInfoFromTags,
  nostrPowFromInstance,
  effectivePowFirstContactFromInstance,
  isV2FirstContactProtocolAction,
  nostrPowForProtocolDm,
  instanceBondsEnabled,
  transportFromInstance,
  instanceInfoEventIsAuthentic,
  selectAuthenticInstanceInfoEvent,
} from "./mostroInfo.js";
export type { MostroInstanceInfo } from "./mostroInfo.js";

export { openSqliteStore } from "./db.js";
export type {
  Store,
  UserRow,
  OrderRow,
  AdminDisputeRow,
  SaveOrderInput,
  ReservedTradeIndex,
  OrderStoreResult,
} from "./store.js";

export {
  generateSharedKey,
  deriveChatKeys,
  deriveChatKeysFromShared,
} from "./chatKeys.js";
export type { ChatKeys } from "./chatKeys.js";

export {
  CHAT_MAX_CLOCK_SKEW_SECS,
  CHAT_MAX_CONTENT_BYTES,
  wrapChatMessage,
  unwrapChatMessage,
} from "./chat.js";
export type { ChatMessage } from "./chat.js";
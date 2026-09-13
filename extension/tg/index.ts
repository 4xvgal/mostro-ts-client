// mostro-trust-graph extension — off-Mostro social trust layer.
// Spec: mostro-trust-graph-spec v0.1.1. Core library is NOT modified.

export { computePpr } from "./ppr.js";
export type { Adjacency, PprOptions } from "./ppr.js";
export { ATTESTATION_KIND, FOLLOW_LIST_KIND, parseAttestation, adjacencyFromAttestations, fetchGraph } from "./graph.js";
export type { Attestation, FetchGraphParams, FetchGraphResult, EventSource, EventPublisher, SeedEdge } from "./graph.js";
export {
  TG_V1_PREFIX,
  TG_V1R_PREFIX,
  isTgToken,
  splitPm,
  canonicalBase,
  parseTgToken,
  buildChallenge,
  buildPmToken,
  verifyPmToken,
  extractTokenFromSegments,
  insertToken,
} from "./token.js";
export type { TgOrderFields, TgChallengeInput, TgVariant, ParsedTgToken } from "./token.js";
export { FirstSeenTracker } from "./firstSeen.js";
export type { SeenVerdict } from "./firstSeen.js";
export { pprScorer } from "./scorer.js";
export type { Scorer } from "./scorer.js";
export { MemoryTrustGraphStore } from "./store.js";
export type { TrustGraphStore, FirstSeenRecord, AttestationSnapshot } from "./store.js";
export { TrustGraphViewer } from "./viewer.js";
export type { ViewerOptions } from "./viewer.js";
export { LocalStorageTrustGraphStore, openLocalStorageTrustGraphStore } from "./store-browser.js";
export {
  ATTEST_CONTEXT,
  attestationDTag,
  contextFromDTag,
  buildAttestation,
  buildRevoke,
  publishAttestation,
  revokeAttestation,
  revokeAll,
  publishAll,
  fetchFollowList,
  verifyHintHolds,
  auditHints,
} from "./attest.js";
export type { BuildAttestationParams } from "./attest.js";
export { publishEvent, PublishError } from "./publish.js";
export type { PublishReport, PublishResult, RelayPublish } from "./publish.js";
export {
  SOCIAL_INDEX_KIND,
  SOCIAL_INDEX_D,
  TRUST_GRAPH_TAG,
  buildSocialIndex,
  parseSocialIndex,
  publishSocialIndex,
  revokeSocialIndex,
  fetchSocialIndex,
  buildFollowList,
  publishFollowList,
  buildTrustGraphDm,
  sendTrustGraphDm,
  parseTrustGraphDm,
  PUBLIC_REPUTATION_DISCLOSURE,
  disclosureFor,
} from "./social.js";
export type { SocialIndexEntry, TrustGraphDmPayload, ReputationMode } from "./social.js";
export { MemoryTelemetrySink, noopTelemetry, summarizeTelemetry, formatSummary } from "./telemetry.js";
export type { TelemetrySink, TelemetryEvent, TelemetrySummary } from "./telemetry.js";
export { buildOrderBinding, verifyOrderBinding, verifyOrderBindingFromOrder, TrustGraph } from "./api.js";
export type {
  OrderBindingParams,
  OrderBindingResult,
  TrustGraphOptions,
  TrustGraphSnapshot,
  TrustBadge,
  TrustState,
} from "./api.js";
export {
  IdentityIndex,
  annotateOrders,
  filterByTrust,
  sortByTrust,
  badgeFrom,
} from "./join.js";
export type {
  TrustScorer,
  IdentityClaim,
  TrustSignals,
  AnnotatedOrder,
  TrustThresholds,
  AnnotateParams,
  TrustQuery,
} from "./join.js";

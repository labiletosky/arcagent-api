// src/constants.ts
var CIRCLE_BATCHING_NAME = "GatewayWalletBatched";
var CIRCLE_BATCHING_VERSION = "1";
var CIRCLE_BATCHING_SCHEME = "exact";
var GATEWAY_MIN_AUTH_VALIDITY_SECONDS = 7 * 24 * 60 * 60;
var GATEWAY_AUTH_VALIDITY_BUFFER_SECONDS = 100;
var GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS = GATEWAY_MIN_AUTH_VALIDITY_SECONDS + GATEWAY_AUTH_VALIDITY_BUFFER_SECONDS;

// src/detection.ts
function supportsBatching(requirements) {
  const extra = requirements.extra;
  if (!extra) {
    return false;
  }
  return extra.name === CIRCLE_BATCHING_NAME && extra.version === CIRCLE_BATCHING_VERSION;
}
var isBatchPayment = supportsBatching;
function getVerifyingContract(requirements) {
  if (!supportsBatching(requirements)) {
    return void 0;
  }
  const verifyingContract = requirements.extra?.verifyingContract;
  if (typeof verifyingContract === "string") {
    return verifyingContract;
  }
  return void 0;
}
export {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_SCHEME,
  CIRCLE_BATCHING_VERSION,
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
  getVerifyingContract,
  isBatchPayment,
  supportsBatching
};
//# sourceMappingURL=index.mjs.map
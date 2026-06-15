"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  CIRCLE_BATCHING_NAME: () => CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_SCHEME: () => CIRCLE_BATCHING_SCHEME,
  CIRCLE_BATCHING_VERSION: () => CIRCLE_BATCHING_VERSION,
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS: () => GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
  getVerifyingContract: () => getVerifyingContract,
  isBatchPayment: () => isBatchPayment,
  supportsBatching: () => supportsBatching
});
module.exports = __toCommonJS(src_exports);

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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_SCHEME,
  CIRCLE_BATCHING_VERSION,
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
  getVerifyingContract,
  isBatchPayment,
  supportsBatching
});
//# sourceMappingURL=index.js.map
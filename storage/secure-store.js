import { getRecord, putRecord, deleteRecord } from "./indexeddb.js";
import { createDefaultSecurityState, normalizeSecurityState } from "../security/lock.js";

export const ID_APP_DATA = "appData";
export const ID_CRYPTO_META = "cryptoMeta";
export const ID_SECURITY_STATE = "securityState";

export async function loadEncryptedAppData() {
  return getRecord(ID_APP_DATA);
}

export async function saveEncryptedAppData(payload) {
  await putRecord(ID_APP_DATA, payload);
}

export async function loadCryptoMeta() {
  return getRecord(ID_CRYPTO_META);
}

export async function saveCryptoMeta(meta) {
  await putRecord(ID_CRYPTO_META, meta);
}

export async function loadSecurityState() {
  const state = await getRecord(ID_SECURITY_STATE);
  return state ? normalizeSecurityState(state) : createDefaultSecurityState();
}

export async function saveSecurityState(state) {
  await putRecord(ID_SECURITY_STATE, normalizeSecurityState(state));
}

export async function hasSecuritySetup() {
  const [cryptoMeta, appData] = await Promise.all([
    loadCryptoMeta(),
    loadEncryptedAppData()
  ]);
  return !!(cryptoMeta && appData);
}

export async function resetSecureStore() {
  await Promise.all([
    deleteRecord(ID_APP_DATA),
    deleteRecord(ID_CRYPTO_META),
    deleteRecord(ID_SECURITY_STATE)
  ]);
}
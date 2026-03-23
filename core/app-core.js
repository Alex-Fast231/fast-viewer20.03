import { normalizeAppData } from "../data/normalization.js";
import { encryptJSON } from "../crypto/crypto-engine.js";
import { saveEncryptedAppData } from "../storage/secure-store.js";

let runtimeKey = null;
let runtimeData = null;
let cryptoMeta = null;
let securityState = null;
let currentView = "boot";
let currentContext = {};
let persistPromise = null;
let persistScheduled = false;

export function setRuntimeSession(session) {
  runtimeKey = session.runtimeKey ?? null;
  runtimeData = session.runtimeData ? normalizeAppData(session.runtimeData) : null;
  cryptoMeta = session.cryptoMeta ?? cryptoMeta;
  securityState = session.securityState ?? securityState;
}

export function clearRuntimeSession() {
  runtimeKey = null;
  runtimeData = null;
  currentContext = {};
}

export function setCryptoMeta(value) {
  cryptoMeta = value;
}

export function setSecurityState(value) {
  securityState = value;
}

export function getRuntimeData() {
  return runtimeData;
}

export function getRuntimeKey() {
  return runtimeKey;
}

export function getCryptoMeta() {
  return cryptoMeta;
}

export function getSecurityState() {
  return securityState;
}

export function setCurrentView(viewName, context = {}) {
  currentView = viewName;
  currentContext = context;
}

export function getCurrentView() {
  return currentView;
}

export function getCurrentContext() {
  return currentContext;
}

export function mutateRuntimeData(mutatorFn) {
  if (!runtimeData) {
    throw new Error("Kein runtimeData Zustand vorhanden");
  }

  mutatorFn(runtimeData);
  runtimeData = normalizeAppData(runtimeData);
  return runtimeData;
}

export async function persistRuntimeData() {
  if (!runtimeKey || !runtimeData) {
    throw new Error("Runtime Session ist nicht entsperrt");
  }

  const normalized = normalizeAppData(runtimeData);
  const encrypted = await encryptJSON(normalized, runtimeKey);
  await saveEncryptedAppData(encrypted);
  runtimeData = normalized;
}

export function queuePersistRuntimeData() {
  if (persistPromise) return persistPromise;
  if (persistScheduled) return persistPromise;

  persistScheduled = true;

  persistPromise = new Promise((resolve, reject) => {
    queueMicrotask(async () => {
      try {
        persistScheduled = false;
        await persistRuntimeData();
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        persistPromise = null;
      }
    });
  });

  return persistPromise;
}
import { generateId } from "../core/utils.js";

export function createSecurityLogEntry(type, payload = {}) {
  return {
    id: generateId("sec"),
    type,
    status: payload.status || "",
    method: payload.method || "",
    message: payload.message || "",
    details: payload.details || null,
    createdAt: new Date().toISOString()
  };
}

export function appendSecurityLog(runtimeData, entry, maxEntries = 200) {
  if (!runtimeData.security || typeof runtimeData.security !== "object") {
    runtimeData.security = {
      log: [],
      lastSecurityChangeAt: "",
      privacyMode: "full"
    };
  }

  if (!Array.isArray(runtimeData.security.log)) {
    runtimeData.security.log = [];
  }

  runtimeData.security.log.unshift(entry);
  runtimeData.security.log = runtimeData.security.log.slice(0, maxEntries);
  runtimeData.security.lastSecurityChangeAt = new Date().toISOString();

  return runtimeData;
}

export function logSecurityEvent(runtimeData, type, payload = {}) {
  const entry = createSecurityLogEntry(type, payload);
  return appendSecurityLog(runtimeData, entry);
}
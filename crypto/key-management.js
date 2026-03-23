import {
  deriveKeyFromPassword,
  deriveKeyFromPIN,
  encryptJSON,
  decryptJSON,
  exportKeyRaw,
  importKeyRaw,
  toBase64,
  fromBase64
} from "./crypto-engine.js";

export async function generateDataKey() {
  return crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256
    },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function wrapDataKeyWithPassword(dataKey, password, passwordSaltBytes) {
  const passwordKey = await deriveKeyFromPassword(password, passwordSaltBytes);
  const rawDataKey = await exportKeyRaw(dataKey);
  const wrapped = await encryptJSON({ rawKeyBase64: toBase64(rawDataKey) }, passwordKey);

  return {
    ivBase64: wrapped.ivBase64,
    wrappedKeyBase64: wrapped.cipherBase64
  };
}

export async function wrapDataKeyWithPIN(dataKey, pin, pinSaltBytes) {
  const pinKey = await deriveKeyFromPIN(pin, pinSaltBytes);
  const rawDataKey = await exportKeyRaw(dataKey);
  const wrapped = await encryptJSON({ rawKeyBase64: toBase64(rawDataKey) }, pinKey);

  return {
    ivBase64: wrapped.ivBase64,
    wrappedKeyBase64: wrapped.cipherBase64
  };
}

export async function unwrapDataKeyWithPassword(wrappedPayload, password, passwordSaltBytes) {
  const passwordKey = await deriveKeyFromPassword(password, passwordSaltBytes);
  const result = await decryptJSON(
    {
      ivBase64: wrappedPayload.ivBase64,
      cipherBase64: wrappedPayload.wrappedKeyBase64
    },
    passwordKey
  );

  return importKeyRaw(fromBase64(result.rawKeyBase64));
}

export async function unwrapDataKeyWithPIN(wrappedPayload, pin, pinSaltBytes) {
  const pinKey = await deriveKeyFromPIN(pin, pinSaltBytes);
  const result = await decryptJSON(
    {
      ivBase64: wrappedPayload.ivBase64,
      cipherBase64: wrappedPayload.wrappedKeyBase64
    },
    pinKey
  );

  return importKeyRaw(fromBase64(result.rawKeyBase64));
}
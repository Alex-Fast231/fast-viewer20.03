function uint8ToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToUint8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function textToUint8(text) {
  return new TextEncoder().encode(text);
}

function uint8ToText(bytes) {
  return new TextDecoder().decode(bytes);
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function generateSalt(length = 16) {
  return randomBytes(length);
}

async function deriveKey(secret, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textToUint8(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 250000,
      hash: "SHA-256"
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function deriveKeyFromPassword(password, saltBytes) {
  return deriveKey(password, saltBytes);
}

export async function deriveKeyFromPIN(pin, saltBytes) {
  return deriveKey(pin, saltBytes);
}

export async function encryptJSON(data, cryptoKey) {
  const iv = randomBytes(12);
  const encoded = textToUint8(JSON.stringify(data));

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encoded
  );

  return {
    ivBase64: uint8ToBase64(iv),
    cipherBase64: uint8ToBase64(new Uint8Array(cipherBuffer))
  };
}

export async function decryptJSON(encryptedPayload, cryptoKey) {
  const iv = base64ToUint8(encryptedPayload.ivBase64);
  const cipherBytes = base64ToUint8(encryptedPayload.cipherBase64);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    cipherBytes
  );

  return JSON.parse(uint8ToText(new Uint8Array(plainBuffer)));
}

export async function exportKeyRaw(cryptoKey) {
  const raw = await crypto.subtle.exportKey("raw", cryptoKey);
  return new Uint8Array(raw);
}

export async function importKeyRaw(rawKeyBytes) {
  return crypto.subtle.importKey(
    "raw",
    rawKeyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export function toBase64(bytes) {
  return uint8ToBase64(bytes);
}

export function fromBase64(base64) {
  return base64ToUint8(base64);
}

export async function encryptText(plainText, cryptoKey) {
  const iv = randomBytes(12);
  const encoded = textToUint8(String(plainText || ""));
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encoded
  );

  return {
    ivBase64: uint8ToBase64(iv),
    cipherBase64: uint8ToBase64(new Uint8Array(cipherBuffer))
  };
}

export async function decryptText(encryptedPayload, cryptoKey) {
  const iv = base64ToUint8(encryptedPayload.ivBase64);
  const cipherBytes = base64ToUint8(encryptedPayload.cipherBase64);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    cipherBytes
  );
  return uint8ToText(new Uint8Array(plainBuffer));
}

import { generateSalt, toBase64, fromBase64, encryptJSON, decryptJSON, encryptText, decryptText } from "../crypto/crypto-engine.js";
import { generateDataKey, wrapDataKeyWithPassword, wrapDataKeyWithPIN, unwrapDataKeyWithPassword, unwrapDataKeyWithPIN } from "../crypto/key-management.js";
import { normalizeAppData } from "../data/normalization.js";
import { createDefaultSecurityState, isLockedOut, registerFailedLogin, registerSuccessfulUnlock } from "./lock.js";
import { saveCryptoMeta, saveEncryptedAppData, saveSecurityState } from "../storage/secure-store.js";

export async function createCryptoMeta({ password, pin, dataKey }) {
  const passwordSaltBytes = generateSalt(16);
  const pinSaltBytes = generateSalt(16);
  const backupSaltBytes = generateSalt(16);

  const wrappedByPassword = await wrapDataKeyWithPassword(dataKey, password, passwordSaltBytes);
  const wrappedByPIN = await wrapDataKeyWithPIN(dataKey, pin, pinSaltBytes);
  const encryptedPracticePasswordByDataKey = await encryptText(password, dataKey);

  return {
    schemaVersion: 1,
    passwordSaltBase64: toBase64(passwordSaltBytes),
    pinSaltBase64: toBase64(pinSaltBytes),
    backupSaltBase64: toBase64(backupSaltBytes),
    wrappedDataKeyByPassword: wrappedByPassword,
    wrappedDataKeyByPIN: wrappedByPIN,
    encryptedPracticePasswordByDataKey
  };
}

export async function setupSecurity({ password, pin, initialAppData }) {
  const normalized = normalizeAppData(initialAppData);
  const dataKey = await generateDataKey();
  const cryptoMeta = await createCryptoMeta({ password, pin, dataKey });
  const encryptedAppData = await encryptJSON(normalized, dataKey);
  const securityState = createDefaultSecurityState();

  await saveCryptoMeta(cryptoMeta);
  await saveEncryptedAppData(encryptedAppData);
  await saveSecurityState(securityState);

  return {
    runtimeKey: dataKey,
    runtimeData: normalized,
    cryptoMeta,
    securityState
  };
}

export async function unlockWithPIN({ pin, cryptoMeta, encryptedAppData, securityState }) {
  if (isLockedOut(securityState)) {
    const err = new Error("LOCKED_OUT");
    err.code = "LOCKED_OUT";
    err.securityState = securityState;
    throw err;
  }

  try {
    const dataKey = await unwrapDataKeyWithPIN(
      cryptoMeta.wrappedDataKeyByPIN,
      pin,
      fromBase64(cryptoMeta.pinSaltBase64)
    );

    const data = await decryptJSON(encryptedAppData, dataKey);
    const runtimeData = normalizeAppData(data);
    const nextSecurityState = registerSuccessfulUnlock(securityState, "pin");

    await saveSecurityState(nextSecurityState);

    return {
      runtimeKey: dataKey,
      runtimeData,
      securityState: nextSecurityState
    };
  } catch {
    const nextSecurityState = registerFailedLogin(securityState);
    await saveSecurityState(nextSecurityState);

    const err = new Error("INVALID_PIN");
    err.code = "INVALID_PIN";
    err.securityState = nextSecurityState;
    throw err;
  }
}


export async function getPracticePasswordFromRuntime({ runtimeKey, cryptoMeta }) {
  if (!runtimeKey) {
    throw new Error("Runtime-Key fehlt");
  }

  const payload = cryptoMeta?.encryptedPracticePasswordByDataKey;
  if (!payload?.ivBase64 || !payload?.cipherBase64) {
    throw new Error("Praxispasswort ist nicht verfügbar");
  }

  const password = await decryptText(payload, runtimeKey);
  if (!password || password.length < 8) {
    throw new Error("Praxispasswort ist ungültig");
  }
  return password;
}

export async function verifyPracticePassword({ password, cryptoMeta }) {
  try {
    await unwrapDataKeyWithPassword(
      cryptoMeta.wrappedDataKeyByPassword,
      password,
      fromBase64(cryptoMeta.passwordSaltBase64)
    );
    return true;
  } catch {
    return false;
  }
}
import { openDatabase } from "../storage/indexeddb.js";
import { hasSecuritySetup, loadCryptoMeta, loadSecurityState } from "../storage/secure-store.js";
import { setCryptoMeta, setSecurityState } from "./app-core.js";
import { createAutoLockController } from "../security/lock.js";
import {
  showSetupView,
  showLoginView,
  showDashboardView,
  performLock,
  resumeCurrentView
} from "../ui/views.js";

let autoLockController = null;

async function determineStartupState() {
  const setupExists = await hasSecuritySetup();
  return setupExists ? "login" : "setup";
}

function lockApp() {
  if (autoLockController) {
    autoLockController.stop();
  }

  performLock({
    onLocked: async () => {
      const state = await loadSecurityState();
      setSecurityState(state);
      showLoginView({ onSuccess: handleUnlocked });
    }
  });
}

function ensureAutoLock() {
  if (!autoLockController) {
    autoLockController = createAutoLockController(() => lockApp());
    autoLockController.bindActivityEvents();
  }
  autoLockController.start();
}

function handleUnlocked() {
  ensureAutoLock();
  resumeCurrentView({ onLock: lockApp });
}

async function bootstrapApp() {
  await openDatabase();

  const startupState = await determineStartupState();

  if (startupState === "setup") {
    showSetupView({
      onSuccess: handleUnlocked
    });
    return;
  }

  const cryptoMeta = await loadCryptoMeta();
  const securityState = await loadSecurityState();

  setCryptoMeta(cryptoMeta);
  setSecurityState(securityState);

  showLoginView({
    onSuccess: handleUnlocked
  });
}

bootstrapApp().catch((err) => {
  console.error(err);
  document.getElementById("app").innerHTML = `
    <div class="card">
      <h2>Startfehler</h2>
      <p>Die App konnte nicht gestartet werden.</p>
      <p class="error">${String(err?.message || err)}</p>
    </div>
  `;
});
import { APP_MODULE, APP_SCHEMA_VERSION, APP_VERSION } from "../data/schema.js";
import { finalizeAppStructure, normalizeAppData } from "../data/normalization.js";
import { fromBase64 } from "../crypto/crypto-engine.js";
import { getPracticePasswordFromRuntime, verifyPracticePassword } from "../security/auth.js";
import {
  loadEncryptedAppData,
  loadCryptoMeta,
  loadSecurityState,
  saveEncryptedAppData,
  saveCryptoMeta,
  saveSecurityState
} from "../storage/secure-store.js";
import { getRuntimeKey } from "../core/app-core.js";
import { createDefaultSecurityState } from "../security/lock.js";

function requireZip() {
  if (!globalThis.zip) {
    throw new Error("ZIP Bibliothek ist nicht geladen");
  }
  return globalThis.zip;
}

function safeJsonParse(text, filename) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${filename} ist kein gültiges JSON`);
  }
}

function ensureNonEmptyObject(value, filename) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filename} ist ungültig`);
  }
}

function sanitizeFilenamePart(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function ensureBase64String(value, fieldLabel) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldLabel} fehlt`);
  }

  try {
    const bytes = fromBase64(value);
    if (!bytes || bytes.length === 0) {
      throw new Error("EMPTY");
    }
  } catch {
    throw new Error(`${fieldLabel} ist ungültig`);
  }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clonePlainObject(value) {
  return isPlainObject(value) ? { ...value } : {};
}

function ensureStringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function ensureArrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function generateMigrationId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}


function ensureArrayField(value) {
  return Array.isArray(value) ? value : [];
}

function ensureStringField(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function ensureSchemaVersion(value, fallback = 1) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function normalizeLegacyDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const dd = String(value.getDate()).padStart(2, "0");
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const yyyy = String(value.getFullYear());
    return `${dd}.${mm}.${yyyy}`;
  }

  const raw = String(value || "").trim();
  if (!raw) return "";

  const deMatch = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (deMatch) {
    const dd = deMatch[1].padStart(2, "0");
    const mm = deMatch[2].padStart(2, "0");
    return `${dd}.${mm}.${deMatch[3]}`;
  }

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (isoMatch) {
    return `${isoMatch[3]}.${isoMatch[2]}.${isoMatch[1]}`;
  }

  const compactMatch = raw.replace(/\D/g, "").match(/^(\d{2})(\d{2})(\d{4})$/);
  if (compactMatch) {
    return `${compactMatch[1]}.${compactMatch[2]}.${compactMatch[3]}`;
  }

  return raw;
}

function normalizeEntryForMigration(entry) {
  const source = clonePlainObject(entry);
  return {
    ...source,
    entryId: ensureStringValue(source.entryId || source.id) || generateMigrationId("entry"),
    date: normalizeLegacyDateValue(source.date || source.datum),
    text: ensureStringValue(source.text || source.doku || source.note),
    linkedTimeEntryId: ensureStringValue(source.linkedTimeEntryId || source.timeEntryId),
    autoTimeMinutes: Number.isFinite(Number(source.autoTimeMinutes)) ? Number(source.autoTimeMinutes) : 0
  };
}

function normalizeTimeEntryForMigration(entry) {
  const source = clonePlainObject(entry);
  const type = ensureStringValue(source.type).trim();
  return {
    ...source,
    timeEntryId: ensureStringValue(source.timeEntryId || source.id) || generateMigrationId("time"),
    date: normalizeLegacyDateValue(source.date || source.datum),
    minutes: Number.isFinite(Number(source.minutes ?? source.duration ?? source.dauer))
      ? Number(source.minutes ?? source.duration ?? source.dauer)
      : 0,
    type: ["behandlung", "dokumentation", "besprechung", "manuell"].includes(type) ? type : "behandlung",
    note: ensureStringValue(source.note || source.text),
    sourceEntryId: ensureStringValue(source.sourceEntryId || source.linkedEntryId),
    confirmed: typeof source.confirmed === "boolean" ? source.confirmed : true
  };
}

function normalizeItemForMigration(item) {
  const source = clonePlainObject(item);
  const type = ensureStringValue(source.type || source.leistung).trim();
  return {
    ...source,
    itemId: ensureStringValue(source.itemId || source.id) || generateMigrationId("item"),
    type,
    count: type === "Blanko" ? "" : ensureStringValue(source.count ?? source.anzahl ?? source.menge)
  };
}

function normalizeRezeptForMigration(rezept) {
  const source = clonePlainObject(rezept);
  const items = Array.isArray(source.items)
    ? source.items.map(normalizeItemForMigration).filter((item) => item.type)
    : (() => {
        const type = ensureStringValue(source.leistung).trim();
        return type
          ? [{
              itemId: generateMigrationId("item"),
              type,
              count: type === "Blanko" ? "" : ensureStringValue(source.anzahl ?? source.count ?? source.menge)
            }]
          : [];
      })();

  return {
    ...source,
    rezeptId: ensureStringValue(source.rezeptId || source.id) || generateMigrationId("rezept"),
    patientId: ensureStringValue(source.patientId || source.patientRef || source.ownerPatientId),
    arzt: ensureStringValue(source.arzt || source.doctor),
    ausstell: normalizeLegacyDateValue(
      source.ausstell
      || source.ausstellungsdatum
      || source.issueDate
      || source.datum
      || source.verordnungsdatum
    ),
    items,
    entries: ensureArrayValue(source.entries).map(normalizeEntryForMigration),
    timeEntries: ensureArrayValue(source.timeEntries).map(normalizeTimeEntryForMigration),
    doctorReports: ensureArrayValue(source.doctorReports).map((item) => {
      const report = clonePlainObject(item);
      return {
        ...report,
        reportId: ensureStringValue(report.reportId || report.id) || generateMigrationId("report"),
        content: ensureStringValue(report.content || report.text),
        createdAt: ensureStringValue(report.createdAt) || new Date().toISOString(),
        updatedAt: ensureStringValue(report.updatedAt) || ensureStringValue(report.createdAt) || new Date().toISOString()
      };
    })
  };
}

function normalizePatientForMigration(patient) {
  const source = clonePlainObject(patient);
  return {
    ...source,
    patientId: ensureStringValue(source.patientId || source.id) || generateMigrationId("patient"),
    firstName: ensureStringValue(source.firstName || source.vorname),
    lastName: ensureStringValue(source.lastName || source.nachname || source.name),
    birthDate: normalizeLegacyDateValue(source.birthDate || source.geburtsdatum || source.geb),
    entries: ensureArrayValue(source.entries).map(normalizeEntryForMigration),
    rezepte: ensureArrayValue(source.rezepte).map(normalizeRezeptForMigration)
  };
}

function normalizeHomeForMigration(home) {
  const source = clonePlainObject(home);
  return {
    ...source,
    homeId: ensureStringValue(source.homeId || source.id) || generateMigrationId("home"),
    name: ensureStringValue(source.name || source.heim || source.titel),
    adresse: ensureStringValue(source.adresse || source.address),
    patients: ensureArrayValue(source.patients).map(normalizePatientForMigration)
  };
}

function normalizeKnownRouteForMigration(route) {
  const source = clonePlainObject(route);
  return {
    ...source,
    routeId: ensureStringValue(source.routeId || source.id) || generateMigrationId("route"),
    fromPointId: ensureStringValue(source.fromPointId),
    toPointId: ensureStringValue(source.toPointId),
    fromLabel: ensureStringValue(source.fromLabel || source.from),
    toLabel: ensureStringValue(source.toLabel || source.to),
    km: Number.isFinite(Number(source.km)) ? Number(source.km) : 0
  };
}

function normalizeTravelLogForMigration(entry) {
  const source = clonePlainObject(entry);
  const date = normalizeLegacyDateValue(source.date || source.datum);
  const km = Number(source.km);
  if (!date || !Number.isFinite(km) || km < 0) {
    return null;
  }

  return {
    ...source,
    travelId: ensureStringValue(source.travelId || source.id) || generateMigrationId("travel"),
    date,
    fromPointId: ensureStringValue(source.fromPointId),
    toPointId: ensureStringValue(source.toPointId),
    fromLabel: ensureStringValue(source.fromLabel || source.from),
    toLabel: ensureStringValue(source.toLabel || source.to),
    km,
    source: ensureStringValue(source.source || "auto") || "auto",
    relatedEntryId: ensureStringValue(source.relatedEntryId || source.entryId),
    note: ensureStringValue(source.note)
  };
}

function normalizeAbsenceForMigration(item) {
  const source = clonePlainObject(item);
  const type = ensureStringValue(source.type).trim().toLowerCase() === "krank" ? "krank" : "urlaub";
  return {
    ...source,
    id: ensureStringValue(source.id) || generateMigrationId("abwesenheit"),
    type,
    from: normalizeLegacyDateValue(source.from || source.von),
    to: normalizeLegacyDateValue(source.to || source.bis)
  };
}

function integrateLegacyFlatCollections(result) {
  const homes = ensureArrayValue(result.homes);
  const legacyPatients = ensureArrayValue(result.patients).map(normalizePatientForMigration);
  const legacyRezepte = ensureArrayValue(result.verordnungen).map(normalizeRezeptForMigration);

  const patientMap = new Map();
  homes.forEach((home) => {
    ensureArrayValue(home.patients).forEach((patient) => {
      patientMap.set(patient.patientId, patient);
    });
  });

  let legacyHome = homes.find((home) => ensureStringValue(home.homeId) === "legacy_import_home");
  if ((!legacyHome && legacyPatients.length) || legacyRezepte.some((rezept) => !patientMap.has(rezept.patientId))) {
    legacyHome = legacyHome || {
      homeId: "legacy_import_home",
      name: "Importierte Alt-Daten",
      adresse: "",
      patients: []
    };
    if (!homes.includes(legacyHome)) {
      homes.push(legacyHome);
    }
  }

  legacyPatients.forEach((patient) => {
    if (!patientMap.has(patient.patientId)) {
      legacyHome.patients.push(patient);
      patientMap.set(patient.patientId, patient);
    }
  });

  legacyRezepte.forEach((rezept) => {
    const patientId = ensureStringValue(rezept.patientId);
    let patient = patientId ? patientMap.get(patientId) : null;

    if (!patient) {
      patient = {
        patientId: patientId || generateMigrationId("patient"),
        firstName: "",
        lastName: "Importiert",
        birthDate: "",
        befreit: false,
        hb: false,
        verstorben: false,
        entries: [],
        rezepte: []
      };
      legacyHome.patients.push(patient);
      patientMap.set(patient.patientId, patient);
    }

    const alreadyExists = ensureArrayValue(patient.rezepte).some((item) => ensureStringValue(item.rezeptId) === rezept.rezeptId);
    if (!alreadyExists) {
      patient.rezepte = ensureArrayValue(patient.rezepte);
      patient.rezepte.push(rezept);
    }
  });

  result.homes = homes;
}

export function migrateBackupData(data, fromVersion) {
  const source = isPlainObject(data) ? clonePlainObject(data) : data;
  const version = Number.isFinite(Number(fromVersion)) && Number(fromVersion) > 0 ? Number(fromVersion) : 1;

  if (!isPlainObject(source)) {
    return data;
  }

  if (typeof source.cipherBase64 === "string" && typeof source.ivBase64 === "string") {
    return {
      ...source,
      schemaVersion: ensureSchemaVersion(source.schemaVersion, version)
    };
  }

  if (typeof source.passwordSaltBase64 === "string" || typeof source.pinSaltBase64 === "string") {
    return {
      ...source,
      schemaVersion: ensureSchemaVersion(source.schemaVersion, version)
    };
  }

  if (source.type === "fast-doku-backup" || Object.prototype.hasOwnProperty.call(source, "viewerCompatible")) {
    return {
      ...source,
      schemaVersion: ensureSchemaVersion(source.schemaVersion, version),
      therapistName: ensureStringField(source.therapistName),
      therapistFax: ensureStringField(source.therapistFax),
      practicePhone: ensureStringField(source.practicePhone),
      workDays: ensureArrayField(source.workDays),
      weeklyHours: typeof source.weeklyHours === "number" ? String(source.weeklyHours) : ensureStringField(source.weeklyHours)
    };
  }

  const result = {
    ...source,
    schemaVersion: version,
    homes: ensureArrayValue(source.homes).map(normalizeHomeForMigration),
    patients: ensureArrayValue(source.patients).map(normalizePatientForMigration),
    verordnungen: ensureArrayValue(source.verordnungen).map(normalizeRezeptForMigration),
    zeit: isPlainObject(source.zeit) ? { ...source.zeit } : { timeEntries: [] },
    kilometer: isPlainObject(source.kilometer) ? { ...source.kilometer } : { entries: [] },
    abwesenheiten: ensureArrayValue(source.abwesenheiten).map(normalizeAbsenceForMigration)
  };

  result.zeit.timeEntries = ensureArrayValue(result.zeit.timeEntries).map(normalizeTimeEntryForMigration);
  result.kilometer.entries = ensureArrayValue(result.kilometer.entries)
    .map(normalizeTravelLogForMigration)
    .filter(Boolean);
  result.kilometer.knownRoutes = ensureArrayValue(result.kilometer.knownRoutes).map(normalizeKnownRouteForMigration);
  result.kilometer.travelLog = ensureArrayValue(result.kilometer.travelLog)
    .map(normalizeTravelLogForMigration)
    .filter(Boolean);

  integrateLegacyFlatCollections(result);
  return normalizeAppData(result);
}

function countRuntimeEntities(normalized) {
  let patientCount = 0;
  let rezeptCount = 0;
  let entryCount = 0;

  (normalized.homes || []).forEach((home) => {
    patientCount += (home.patients || []).length;
    (home.patients || []).forEach((patient) => {
      rezeptCount += (patient.rezepte || []).length;
      (patient.rezepte || []).forEach((rezept) => {
        entryCount += (rezept.entries || []).length;
      });
    });
  });

  return {
    homeCount: (normalized.homes || []).length,
    patientCount,
    rezeptCount,
    entryCount
  };
}

export function buildBackupMeta(runtimeData) {
  const normalized = finalizeAppStructure(runtimeData);
  const counts = countRuntimeEntities(normalized);

  return {
    type: "fast-doku-backup",
    module: APP_MODULE,
    schemaVersion: APP_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    viewerCompatible: true,
    exportTimestamp: new Date().toISOString(),
    therapistName: normalized.settings?.therapistName || "",
    therapistFax: normalized.settings?.therapistFax || "",
    practicePhone: normalized.settings?.practicePhone || "",
    workDays: Array.isArray(normalized.settings?.workDays) ? normalized.settings.workDays : [],
    weeklyHours: normalized.settings?.weeklyHours || "",
    absenceCount: Array.isArray(normalized.abwesenheiten) ? normalized.abwesenheiten.length : 0,
    counts
  };
}

export async function exportBackup(runtimeData) {
  const encryptedAppData = await loadEncryptedAppData();
  const cryptoMeta = await loadCryptoMeta();
  const securityState = await loadSecurityState();
  const runtimeKey = getRuntimeKey();

  if (!encryptedAppData || !cryptoMeta) {
    throw new Error("Kein vollständiger Sicherungsstand vorhanden");
  }

  if (!runtimeKey) {
    throw new Error("Runtime Session ist nicht entsperrt");
  }

  const practicePassword = await getPracticePasswordFromRuntime({ runtimeKey, cryptoMeta });
  const meta = buildBackupMeta(runtimeData);
  const zipLib = requireZip();
  const writer = new zipLib.ZipWriter(new zipLib.BlobWriter("application/zip"));
  const zipOptions = { password: practicePassword, encryptionStrength: 3 };

  await writer.add("appData.enc", new zipLib.TextReader(JSON.stringify(encryptedAppData)), zipOptions);
  await writer.add("cryptoMeta.json", new zipLib.TextReader(JSON.stringify(cryptoMeta, null, 2)), zipOptions);
  await writer.add("meta.json", new zipLib.TextReader(JSON.stringify(meta, null, 2)), zipOptions);
  await writer.add("securityState.json", new zipLib.TextReader(JSON.stringify(securityState, null, 2)), zipOptions);

  const blob = await writer.close();
  const stamp = meta.exportTimestamp.replace(/[:T]/g, "-").slice(0, 16);
  const therapistSlug = sanitizeFilenamePart(meta.therapistName) || "therapeut";
  const filename = `FaSt-Doku-Backup-${therapistSlug}-${stamp}.zip`;
  return { blob, filename, meta };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function validateBackupMeta(meta) {
  ensureNonEmptyObject(meta, "meta.json");

  if (meta.type !== "fast-doku-backup") {
    throw new Error("Backup-Typ nicht unterstützt");
  }

  if (meta.module !== APP_MODULE) {
    throw new Error("Backup stammt nicht aus FaSt-Doku");
  }

  if (meta.viewerCompatible !== true && meta.viewerCompatible !== false) {
    throw new Error("meta.json enthält kein gültiges viewerCompatible Feld");
  }

  if (!meta.schemaVersion && meta.schemaVersion !== 0) {
    throw new Error("meta.json enthält keine schemaVersion");
  }

  if (!meta.appVersion) {
    throw new Error("meta.json enthält keine appVersion");
  }

  if (!meta.exportTimestamp) {
    throw new Error("meta.json enthält keinen exportTimestamp");
  }

  if (typeof meta.therapistName !== "string") {
    throw new Error("meta.json enthält keinen gültigen Therapeutennamen");
  }

  return meta;
}

function validateWrappedKeyPayload(value, filename, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filename} ist unvollständig: ${fieldName} fehlt`);
  }

  ensureBase64String(value.ivBase64, `${filename}.${fieldName}.ivBase64`);
  ensureBase64String(value.wrappedKeyBase64, `${filename}.${fieldName}.wrappedKeyBase64`);
}

function validateEncryptedSecretPayload(value, filename, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filename} ist unvollständig: ${fieldName} fehlt`);
  }

  ensureBase64String(value.ivBase64, `${filename}.${fieldName}.ivBase64`);
  ensureBase64String(value.cipherBase64, `${filename}.${fieldName}.cipherBase64`);
}

export function validateCryptoMeta(cryptoMeta) {
  ensureNonEmptyObject(cryptoMeta, "cryptoMeta.json");

  if (typeof cryptoMeta.schemaVersion !== "number") {
    throw new Error("cryptoMeta.json ist unvollständig: schemaVersion fehlt");
  }

  ensureBase64String(cryptoMeta.passwordSaltBase64, "cryptoMeta.json.passwordSaltBase64");
  ensureBase64String(cryptoMeta.pinSaltBase64, "cryptoMeta.json.pinSaltBase64");

  validateWrappedKeyPayload(
    cryptoMeta.wrappedDataKeyByPassword,
    "cryptoMeta.json",
    "wrappedDataKeyByPassword"
  );

  validateWrappedKeyPayload(
    cryptoMeta.wrappedDataKeyByPIN,
    "cryptoMeta.json",
    "wrappedDataKeyByPIN"
  );

  validateEncryptedSecretPayload(
    cryptoMeta.encryptedPracticePasswordByDataKey,
    "cryptoMeta.json",
    "encryptedPracticePasswordByDataKey"
  );

  return cryptoMeta;
}

export function validateEncryptedAppData(encryptedAppData) {
  ensureNonEmptyObject(encryptedAppData, "appData.enc");

  ensureBase64String(encryptedAppData.cipherBase64, "appData.enc.cipherBase64");
  ensureBase64String(encryptedAppData.ivBase64, "appData.enc.ivBase64");

  return encryptedAppData;
}

export function resetImportedSecurityState() {
  return createDefaultSecurityState();
}

export function validateBackupPayload({ encryptedAppData, cryptoMeta, meta }) {
  validateEncryptedAppData(encryptedAppData);
  validateCryptoMeta(cryptoMeta);
  validateBackupMeta(meta);

  return true;
}

function validateBackupCompatibility({ encryptedAppData, cryptoMeta, meta }) {
  try {
    validateBackupPayload({ encryptedAppData, cryptoMeta, meta });

    const normalizedMeta = finalizeAppStructure({
      settings: {
        therapistName: meta.therapistName || "",
        practicePhone: meta.practicePhone || "",
        therapistFax: meta.therapistFax || "",
        workDays: Array.isArray(meta.workDays) ? meta.workDays : [],
        weeklyHours: typeof meta.weeklyHours === "string" || typeof meta.weeklyHours === "number" ? meta.weeklyHours : ""
      },
      homes: []
    });

    if (!normalizedMeta?.settings || typeof normalizedMeta.settings !== "object") {
      throw new Error("META_INVALID");
    }

    return true;
  } catch (err) {
    if (String(err?.message || err).includes("ungültig") || String(err?.message || err).includes("fehlt")) {
      throw err;
    }
    throw new Error("Backup beschädigt oder nicht kompatibel");
  }
}

export async function validateBackupZip(file, practicePassword) {
  if (!file) {
    throw new Error("Keine Backup-Datei ausgewählt");
  }

  const normalizedPassword = String(practicePassword || "").trim();
  if (!normalizedPassword || normalizedPassword.length < 8) {
    throw new Error("Falsches Praxispasswort");
  }

  const zipLib = requireZip();
  const reader = new zipLib.ZipReader(new zipLib.BlobReader(file));

  try {
    const entries = await reader.getEntries();
    const entryMap = new Map(entries.map((entry) => [entry.filename, entry]));

    const appEntry = entryMap.get("appData.enc");
    const cryptoEntry = entryMap.get("cryptoMeta.json");
    const metaEntry = entryMap.get("meta.json");
    const securityEntry = entryMap.get("securityState.json");

    if (!appEntry) throw new Error("Backup enthält keine appData.enc");
    if (!cryptoEntry) throw new Error("Backup enthält keine cryptoMeta.json");
    if (!metaEntry) throw new Error("Backup enthält keine meta.json");

    let encryptedAppData;
    let cryptoMeta;
    let meta;
    let securityState;

    try {
      encryptedAppData = safeJsonParse(await appEntry.getData(new zipLib.TextWriter(), { password: normalizedPassword }), "appData.enc");
      cryptoMeta = safeJsonParse(await cryptoEntry.getData(new zipLib.TextWriter(), { password: normalizedPassword }), "cryptoMeta.json");
      meta = safeJsonParse(await metaEntry.getData(new zipLib.TextWriter(), { password: normalizedPassword }), "meta.json");
      securityState = securityEntry
        ? safeJsonParse(await securityEntry.getData(new zipLib.TextWriter(), { password: normalizedPassword }), "securityState.json")
        : resetImportedSecurityState();
    } catch (err) {
      throw new Error("Falsches Praxispasswort");
    }

    validateBackupCompatibility({ encryptedAppData, cryptoMeta, meta });

    const passwordValid = await verifyPracticePassword({ password: normalizedPassword, cryptoMeta });
    if (!passwordValid) {
      throw new Error("Falsches Praxispasswort");
    }

    return {
      encryptedAppData,
      cryptoMeta,
      meta,
      securityState,
      entries: Array.from(entryMap.keys())
    };
  } finally {
    await reader.close();
  }
}

export async function importBackup(file, practicePassword) {
  const payload = await validateBackupZip(file, practicePassword);
  const backupSchemaVersion = ensureSchemaVersion(payload.meta?.schemaVersion, 1);
  const migratedEncryptedAppData = migrateBackupData(payload.encryptedAppData, backupSchemaVersion);
  const migratedCryptoMeta = migrateBackupData(payload.cryptoMeta, backupSchemaVersion);
  const securityState = resetImportedSecurityState();

  await saveEncryptedAppData(migratedEncryptedAppData);
  await saveCryptoMeta(migratedCryptoMeta);
  await saveSecurityState(securityState);

  return {
    meta: payload.meta,
    importedEntries: payload.entries,
    securityState
  };
}

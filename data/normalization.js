import { createEmptyAppData, APP_SCHEMA_VERSION, APP_VERSION, APP_MODULE, PRACTICE_ADDRESS } from "./schema.js";
import { formatDeDate, parseDeDate } from "../core/date-utils.js";
import { generateId, getRezeptAusstellungsdatum } from "../core/utils.js";

function ensureString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function ensureBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}
function ensureWorkDays(value) {
  const allowed = new Set(["MO", "DI", "MI", "DO", "FR"]);
  return ensureArray(value)
    .map((item) => ensureString(item).trim().toUpperCase())
    .filter((item, index, array) => allowed.has(item) && array.indexOf(item) === index);
}


function ensureDeDateString(value) {
  const normalized = formatDeDate(value);
  return parseDeDate(normalized) ? normalized : "";
}

function ensureIsoString(value, fallback = "") {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return fallback;
}

function ensureWeeklyHours(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

function normalizeEntry(entry) {
  const now = new Date().toISOString();
  const item = entry && typeof entry === "object" ? entry : {};

  return {
    entryId: ensureString(item.entryId) || generateId("entry"),
    date: ensureDeDateString(item.date),
    text: ensureString(item.text),
    createdAt: ensureIsoString(item.createdAt, now),
    updatedAt: ensureIsoString(item.updatedAt, now),
    linkedTimeEntryId: ensureString(item.linkedTimeEntryId),
    autoTimeMinutes: Number.isFinite(Number(item.autoTimeMinutes)) ? Number(item.autoTimeMinutes) : 0
  };
}

function normalizeItem(item) {
  const source = item && typeof item === "object" ? item : {};
  const type = ensureString(source.type).trim();
  if (!type) return null;

  return {
    itemId: ensureString(source.itemId) || generateId("item"),
    type,
    count: type === "Blanko" ? "" : ensureString(source.count)
  };
}

function getNormalizedRezeptAusstellungsdatum(source) {
  return ensureDeDateString(getRezeptAusstellungsdatum(source));
}

function normalizeRezept(rezept) {
  const source = rezept && typeof rezept === "object" ? rezept : {};
  let items = [];

  if (Array.isArray(source.items)) {
    items = source.items.map(normalizeItem).filter(Boolean);
  } else {
    const leistung = ensureString(source.leistung).trim();
    if (leistung) {
      items = [
        normalizeItem({
          type: leistung,
          count: source.anzahl ?? ""
        })
      ].filter(Boolean);
    }
  }

  const statusValue = ensureString(source.status, "Aktiv") || "Aktiv";
const allowedStatus = ["Aktiv", "Pausiert", "Abgeschlossen", "Abgegeben"].includes(statusValue)
  ? statusValue
  : "Aktiv";

return {
  rezeptId: ensureString(source.rezeptId || source.id) || generateId("rezept"),
  arzt: ensureString(source.arzt || source.doctor),
  ausstell: getNormalizedRezeptAusstellungsdatum(source),
  status: allowedStatus,
  bg: ensureBoolean(source.bg, false),
  dt: ensureBoolean(source.dt, false),
  items,
  entries: ensureArray(source.entries).map(normalizeEntry),
  zeitMeta: source.zeitMeta && typeof source.zeitMeta === "object"
    ? source.zeitMeta
    : {
        plannedTimeMinutes: 0,
        lastTimeEntryAt: "",
        kilometerRelevant: true
      },
  exportMeta: source.exportMeta && typeof source.exportMeta === "object"
    ? source.exportMeta
    : {
        exportReady: true,
        viewerLabel: "",
        lastExportAt: ""
      },
  timeEntries: ensureArray(source.timeEntries).map((item) => {
    const now = new Date().toISOString();
    const entry = item && typeof item === "object" ? item : {};
    return {
      timeEntryId: ensureString(entry.timeEntryId) || generateId("time"),
      date: ensureDeDateString(entry.date),
      minutes: Number.isFinite(Number(entry.minutes)) ? Number(entry.minutes) : 0,
      type: ["behandlung", "dokumentation", "besprechung", "manuell"].includes(ensureString(entry.type))
        ? ensureString(entry.type)
        : "behandlung",
      note: ensureString(entry.note),
      sourceEntryId: ensureString(entry.sourceEntryId),
      confirmed: ensureBoolean(entry.confirmed, true),
      createdAt: ensureIsoString(entry.createdAt, now),
      updatedAt: ensureIsoString(entry.updatedAt, now)
    };
  }),
  doctorReports: ensureArray(source.doctorReports).map((item) => {
    const now = new Date().toISOString();
    const report = item && typeof item === "object" ? item : {};
    return {
      reportId: ensureString(report.reportId || report.id) || generateId("report"),
      content: ensureString(report.content || report.text),
      createdAt: ensureIsoString(report.createdAt, now),
      updatedAt: ensureIsoString(report.updatedAt, now)
    };
  })
};
}

function normalizePatient(patient) {
  const source = patient && typeof patient === "object" ? patient : {};

  return {
    patientId: ensureString(source.patientId || source.id) || generateId("patient"),
    firstName: ensureString(source.firstName),
    lastName: ensureString(source.lastName),
    birthDate: ensureDeDateString(source.birthDate),
    befreit: ensureBoolean(source.befreit, false),
    hb: ensureBoolean(source.hb, false),
    verstorben: ensureBoolean(source.verstorben, false),
    entries: ensureArray(source.entries).map(normalizeEntry),
    rezepte: ensureArray(source.rezepte).map(normalizeRezept),
    zeitMeta: source.zeitMeta && typeof source.zeitMeta === "object" ? source.zeitMeta : {}
  };
}

function normalizeHome(home) {
  const source = home && typeof home === "object" ? home : {};

  return {
    homeId: ensureString(source.homeId || source.id) || generateId("home"),
    name: ensureString(source.name),
    adresse: ensureString(source.adresse || source.address),
    patients: ensureArray(source.patients).map(normalizePatient)
  };
}

function normalizeAbgabeHistory(items) {
  return ensureArray(items).map((item) => {
    const source = item && typeof item === "object" ? item : {};
    return {
      id: ensureString(source.id) || generateId("abgabe"),
      createdAt: ensureIsoString(source.createdAt),
      title: ensureString(source.title),
      rows: ensureArray(source.rows).map((row) => ({
        heim: ensureString(row?.heim),
        patient: ensureString(row?.patient),
        geb: ensureDeDateString(row?.geb),
        ausstell: ensureDeDateString(row?.ausstell),
        leistung: ensureString(row?.leistung),
        anzahl: ensureString(row?.anzahl),
        menge: ensureString(row?.menge)
      }))
    };
  });
}


function normalizeKilometerState(state) {
  const source = state && typeof state === "object" ? state : {};
  return {
    startPoint: {
      label: ensureString(source.startPoint?.label),
      address: ensureString(source.startPoint?.address)
    },
    knownRoutes: ensureArray(source.knownRoutes).map((item) => ({
      routeId: ensureString(item?.routeId) || generateId("route"),
      fromPointId: ensureString(item?.fromPointId),
      toPointId: ensureString(item?.toPointId),
      fromLabel: ensureString(item?.fromLabel),
      toLabel: ensureString(item?.toLabel),
      km: Number.isFinite(Number(item?.km)) ? Number(item.km) : 0,
      createdAt: ensureIsoString(item?.createdAt, new Date().toISOString()),
      updatedAt: ensureIsoString(item?.updatedAt, new Date().toISOString())
    })),
    travelLog: ensureArray(source.travelLog).map((item) => ({
      travelId: ensureString(item?.travelId) || generateId("travel"),
      date: ensureDeDateString(item?.date),
      fromPointId: ensureString(item?.fromPointId),
      toPointId: ensureString(item?.toPointId),
      fromLabel: ensureString(item?.fromLabel),
      toLabel: ensureString(item?.toLabel),
      km: Number.isFinite(Number(item?.km)) ? Number(item.km) : 0,
      source: ensureString(item?.source, "auto") || "auto",
      relatedEntryId: ensureString(item?.relatedEntryId),
      note: ensureString(item?.note),
      createdAt: ensureIsoString(item?.createdAt, new Date().toISOString()),
      updatedAt: ensureIsoString(item?.updatedAt),
      manualAdjusted: Boolean(item?.manualAdjusted)
    }))
  };
}


function normalizeAbwesenheiten(items) {
  return ensureArray(items).map((item) => {
    const source = item && typeof item === "object" ? item : {};
    const type = ensureString(source.type).trim().toLowerCase() === "krank" ? "krank" : "urlaub";
    return {
      id: ensureString(source.id) || generateId("abwesenheit"),
      type,
      from: ensureDeDateString(source.from || source.von),
      to: ensureDeDateString(source.to || source.bis),
      createdAt: ensureIsoString(source.createdAt, new Date().toISOString()),
      updatedAt: ensureIsoString(source.updatedAt, new Date().toISOString())
    };
  });
}

function normalizeSpecialDays(items) {
  return ensureArray(items).map((item) => {
    const source = item && typeof item === "object" ? item : {};
    return {
      id: ensureString(source.id) || generateId("specialday"),
      type: "holiday",
      date: ensureDeDateString(source.date || source.datum),
      createdAt: ensureIsoString(source.createdAt, new Date().toISOString()),
      updatedAt: ensureIsoString(source.updatedAt, new Date().toISOString())
    };
  }).filter((item) => item.date);
}


function normalizeNachbestellHistory(items) {
  return ensureArray(items).map((item) => {
    const source = item && typeof item === "object" ? item : {};
    return {
      id: ensureString(source.id) || generateId("nachbestellung"),
      createdAt: ensureIsoString(source.createdAt),
      title: ensureString(source.title),
      doctor: ensureString(source.doctor),
      rezeptCount: Number.isFinite(Number(source.rezeptCount)) ? Number(source.rezeptCount) : 0,
      patientCount: Number.isFinite(Number(source.patientCount)) ? Number(source.patientCount) : 0,
      snapshotHtml: ensureString(source.snapshotHtml),
      lines: ensureArray(source.lines).map((line) => ({
        patient: ensureString(line?.patient),
        geb: ensureDeDateString(line?.geb),
        heim: ensureString(line?.heim),
        text: ensureString(line?.text)
      }))
    };
  });
}

export function finalizeAppStructure(data) {
  const base = createEmptyAppData();
  const source = data && typeof data === "object" ? data : {};
  const now = new Date().toISOString();

  const settings = source.settings && typeof source.settings === "object" ? source.settings : {};

  const result = {
    ...base,
    ...source,

    schemaVersion: APP_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    module: APP_MODULE,
    viewerCompatible: true,
    exportTimestamp: ensureIsoString(source.exportTimestamp),

    settings: {
      therapistName: ensureString(settings.therapistName),
      therapistFax: ensureString(settings.therapistFax),
      practicePhone: ensureString(settings.practicePhone),
      practiceAddress: ensureString(settings.practiceAddress, PRACTICE_ADDRESS),
      workDays: ensureWorkDays(settings.workDays),
      weeklyHours: ensureWeeklyHours(settings.weeklyHours),
      privacyMode: ["full", "privacy"].includes(settings.privacyMode) ? settings.privacyMode : "full",
      createdAt: ensureIsoString(settings.createdAt, now),
      updatedAt: ensureIsoString(settings.updatedAt, now) || now
    },

    homes: ensureArray(source.homes).map(normalizeHome),

    doku: {
      version: 1
    },

    zeit: {
      version: 1,
      therapists: ensureArray(source.zeit?.therapists),
      workModels: ensureArray(source.zeit?.workModels),
      timeEntries: ensureArray(source.zeit?.timeEntries),
      approvals: ensureArray(source.zeit?.approvals),
      kilometer: ensureArray(source.zeit?.kilometer),
      reports: ensureArray(source.zeit?.reports)
    },

    kilometer: normalizeKilometerState(source.kilometer),

    abwesenheiten: normalizeAbwesenheiten(source.abwesenheiten),
    specialDays: normalizeSpecialDays(source.specialDays),

    abgabeHistory: normalizeAbgabeHistory(source.abgabeHistory),
    nachbestellHistory: normalizeNachbestellHistory(source.nachbestellHistory),

    security: {
      log: ensureArray(source.security?.log),
      lastSecurityChangeAt: ensureIsoString(source.security?.lastSecurityChangeAt),
      privacyMode: ["full", "privacy"].includes(source.security?.privacyMode)
        ? source.security.privacyMode
        : (["full", "privacy"].includes(settings.privacyMode) ? settings.privacyMode : "full")
    },

    ui: {
      lastBackupAt: ensureIsoString(source.ui?.lastBackupAt)
    }
  };

  return result;
}

export function normalizeAppData(data) {
  return finalizeAppStructure(data);
}

import { getRuntimeData, mutateRuntimeData } from "../core/app-core.js";
import { compareDeDates, isDateInRange } from "../core/date-utils.js";
import { generateId, getRezeptAusstellungsdatum } from "../core/utils.js";

function normalizeTimeType(type) {
  return ["behandlung", "dokumentation", "besprechung", "manuell"].includes(String(type || "").trim())
    ? String(type || "").trim()
    : "behandlung";
}

function normalizeLeistungName(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/–/g, "-")
    .replace(/—/g, "-");
}

function getSingleLeistungMinutes(type) {
  const key = normalizeLeistungName(type);

  if (["KG", "MT", "KG-ZNS", "KGZNS", "MLD30", "BLANKO"].includes(key)) return 20;
  if (key === "MLD45") return 40;
  if (key === "MLD60") return 60;

  return 0;
}

function getAutomaticTreatmentMinutes(rezept) {
  const items = Array.isArray(rezept?.items) ? rezept.items : [];
  if (items.length === 0) return 0;

  if (rezept?.bg) {
    return items.reduce((sum, item) => sum + getSingleLeistungMinutes(item?.type), 0);
  }

  const hasBlanko = items.some((item) => normalizeLeistungName(item?.type) === "BLANKO");
  if (hasBlanko) {
    return 20;
  }

  const firstRelevant = items.find((item) => getSingleLeistungMinutes(item?.type) > 0);
  const firstMinutes = firstRelevant ? getSingleLeistungMinutes(firstRelevant.type) : 0;
  if (!firstMinutes) return 0;

  const firstKey = normalizeLeistungName(firstRelevant?.type);
  const isFixedMLD = firstKey === "MLD45" || firstKey === "MLD60";

  if (rezept?.dt && !isFixedMLD) {
    return firstMinutes * 2;
  }

  return firstMinutes;
}

function createTimeEntryObject(payload = {}) {
  const now = new Date().toISOString();
  const minutes = Number(payload.minutes);
  return {
    timeEntryId: generateId("time"),
    date: String(payload.date || "").trim(),
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 0,
    type: normalizeTimeType(payload.type),
    note: String(payload.note || "").trim(),
    sourceEntryId: String(payload.sourceEntryId || "").trim(),
    confirmed: payload.confirmed !== false,
    createdAt: now,
    updatedAt: now
  };
}

function ensureRezeptTimeState(rezept) {
  if (!Array.isArray(rezept.timeEntries)) {
    rezept.timeEntries = [];
  }

  if (!rezept.zeitMeta || typeof rezept.zeitMeta !== "object") {
    rezept.zeitMeta = {
      plannedTimeMinutes: 0,
      lastTimeEntryAt: "",
      kilometerRelevant: true
    };
  }
}


function getTodayDateString() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function normalizeDateString(value) {
  const s = String(value || "").trim();
  return s || getTodayDateString();
}

function ensureKilometerState(data) {
  if (!data.kilometer || typeof data.kilometer !== "object") {
    data.kilometer = {
      startPoint: { label: "", address: "" },
      knownRoutes: [],
      travelLog: []
    };
  }

  if (!data.kilometer.startPoint || typeof data.kilometer.startPoint !== "object") {
    data.kilometer.startPoint = { label: "", address: "" };
  }

  if (!Array.isArray(data.kilometer.knownRoutes)) {
    data.kilometer.knownRoutes = [];
  }

  if (!Array.isArray(data.kilometer.travelLog)) {
    data.kilometer.travelLog = [];
  }

  return data.kilometer;
}

function getPointForPatient(home, patient, kilometerState) {
  const hbAddress = String(patient?.hbAddress || "").trim();
  if (patient?.hb && hbAddress) {
    return {
      pointId: `hb:${patient.patientId}`,
      label: `${patient.firstName || ""} ${patient.lastName || ""}`.trim() || "Hausbesuch",
      address: hbAddress,
      kind: "hb"
    };
  }

  return {
    pointId: `home:${home.homeId}`,
    label: String(home?.name || "Einrichtung").trim() || "Einrichtung",
    address: String(home?.adresse || "").trim(),
    kind: "home"
  };
}

function collectKilometerPoints(data) {
  const kilometerState = ensureKilometerState(data);
  const points = [];
  const seen = new Set();

  const addPoint = (point) => {
    if (!point || !point.pointId || seen.has(point.pointId)) return;
    seen.add(point.pointId);
    points.push({
      pointId: String(point.pointId || '').trim(),
      label: String(point.label || '').trim(),
      address: String(point.address || '').trim(),
      kind: String(point.kind || '').trim() || 'custom'
    });
  };

  addPoint({
    pointId: 'start',
    label: kilometerState.startPoint.label || 'Startpunkt',
    address: kilometerState.startPoint.address || '',
    kind: 'start'
  });

  (data.homes || []).forEach((home) => {
    addPoint({
      pointId: `home:${home.homeId}`,
      label: String(home?.name || 'Einrichtung').trim() || 'Einrichtung',
      address: String(home?.adresse || '').trim(),
      kind: 'home'
    });

    (home.patients || []).forEach((patient) => {
      if (patient?.hb && String(patient?.hbAddress || '').trim()) {
        addPoint({
          pointId: `hb:${patient.patientId}`,
          label: `${patient.firstName || ''} ${patient.lastName || ''}`.trim() || 'Hausbesuch',
          address: String(patient.hbAddress || '').trim(),
          kind: 'hb'
        });
      }
    });
  });

  return points.sort((a, b) => `${a.label} ${a.address}`.localeCompare(`${b.label} ${b.address}`, 'de'));
}


function findKnownRoute(kilometerState, fromPointId, toPointId) {
  return (kilometerState?.knownRoutes || []).find((route) =>
    route.fromPointId === fromPointId && route.toPointId === toPointId
  ) || null;
}

function getLastTravelForDate(kilometerState, date) {
  const items = (kilometerState?.travelLog || []).filter((item) => item.date === date);
  return items.length ? items[items.length - 1] : null;
}

function isKilometerAutoDateAllowed(dateInput) {
  const entryDate = normalizeDateString(dateInput);
  return entryDate === getTodayDateString();
}

function buildPendingKilometerContextFromData(data, homeId, patientId, dateInput) {
  const home = getHomeById(data, homeId);
  if (!home) throw new Error("Heim nicht gefunden");

  const patient = getPatientById(home, patientId);
  if (!patient) throw new Error("Patient nicht gefunden");

  const kilometerState = ensureKilometerState(data);
  const date = normalizeDateString(dateInput);
  const currentPoint = getPointForPatient(home, patient, kilometerState);
  const lastTravel = getLastTravelForDate(kilometerState, date);

  let fromPointId = "start";
  let fromLabel = kilometerState.startPoint.label || "Startpunkt";
  let fromAddress = kilometerState.startPoint.address || "";

  if (lastTravel?.toPointId) {
    fromPointId = lastTravel.toPointId;
    fromLabel = lastTravel.toLabel;
    fromAddress = "";
  }

  if (fromPointId === currentPoint.pointId) {
    return {
      date,
      needsTravel: false,
      samePoint: true,
      fromPointId,
      toPointId: currentPoint.pointId,
      fromLabel,
      toLabel: currentPoint.label,
      knownRoute: null
    };
  }

  const knownRoute = findKnownRoute(kilometerState, fromPointId, currentPoint.pointId);

  return {
    date,
    needsTravel: true,
    samePoint: false,
    fromPointId,
    toPointId: currentPoint.pointId,
    fromLabel,
    toLabel: currentPoint.label,
    fromAddress,
    toAddress: currentPoint.address,
    knownRoute,
    needsKmInput: !knownRoute,
    knownKm: knownRoute ? Number(knownRoute.km || 0) : 0
  };
}

function appendTravelLogIfPossible(data, homeId, patientId, dateInput, relatedEntryId) {
  if (!isKilometerAutoDateAllowed(dateInput)) return null;

  const context = buildPendingKilometerContextFromData(data, homeId, patientId, dateInput);
  if (!context.needsTravel || context.samePoint || !context.knownRoute) return null;

  const kilometerState = ensureKilometerState(data);
  const duplicate = (kilometerState.travelLog || []).some((item) =>
    item.date === context.date &&
    item.fromPointId === context.fromPointId &&
    item.toPointId === context.toPointId &&
    item.relatedEntryId === relatedEntryId
  );
  if (duplicate) return null;

  const travel = {
    travelId: generateId("travel"),
    date: context.date,
    fromPointId: context.fromPointId,
    toPointId: context.toPointId,
    fromLabel: context.fromLabel,
    toLabel: context.toLabel,
    km: Number(context.knownRoute.km || 0),
    source: "auto",
    relatedEntryId: relatedEntryId || "",
    note: "Automatisch aus Dokumentation",
    createdAt: new Date().toISOString()
  };

  kilometerState.travelLog.push(travel);
  return travel;
}

export function getPendingKilometerContext(homeId, patientId, dateInput) {
  const data = getRuntimeData();
  if (!data) throw new Error("Kein runtimeData Zustand vorhanden");
  return buildPendingKilometerContextFromData(data, homeId, patientId, dateInput);
}

export function saveKilometerStartPoint(payload) {
  mutateRuntimeData((data) => {
    const kilometerState = ensureKilometerState(data);
    kilometerState.startPoint.label = String(payload?.label || "Startpunkt").trim() || "Startpunkt";
    kilometerState.startPoint.address = String(payload?.address || "").trim();
  });
}

export function saveKnownKilometerRoute(payload) {
  mutateRuntimeData((data) => {
    const kilometerState = ensureKilometerState(data);
    const km = Number(payload?.km);
    if (!Number.isFinite(km) || km <= 0) {
      throw new Error("Bitte gültige Kilometer eingeben.");
    }

    const fromPointId = String(payload?.fromPointId || "").trim();
    const toPointId = String(payload?.toPointId || "").trim();
    if (!fromPointId || !toPointId) {
      throw new Error("Route ist unvollständig.");
    }

    const now = new Date().toISOString();
    const upsert = (a, b, aLabel, bLabel) => {
      const existing = findKnownRoute(kilometerState, a, b);
      if (existing) {
        existing.km = km;
        existing.updatedAt = now;
        existing.fromLabel = aLabel;
        existing.toLabel = bLabel;
      } else {
        kilometerState.knownRoutes.push({
          routeId: generateId("route"),
          fromPointId: a,
          toPointId: b,
          fromLabel: aLabel,
          toLabel: bLabel,
          km,
          createdAt: now,
          updatedAt: now
        });
      }
    };

    upsert(fromPointId, toPointId, String(payload?.fromLabel || "").trim(), String(payload?.toLabel || "").trim());
    upsert(toPointId, fromPointId, String(payload?.toLabel || "").trim(), String(payload?.fromLabel || "").trim());
  });
}

export function getKilometerOverview() {
  const data = getRuntimeData();
  if (!data) throw new Error("Kein runtimeData Zustand vorhanden");
  const kilometerState = ensureKilometerState(data);
  return {
    startPoint: kilometerState.startPoint,
    knownRoutes: [...kilometerState.knownRoutes],
    travelLog: [...kilometerState.travelLog]
  };
}

export function getKilometerPointOptions() {
  const data = getRuntimeData();
  if (!data) throw new Error('Kein runtimeData Zustand vorhanden');
  return collectKilometerPoints(data);
}

export function addManualKilometerTravel(payload) {
  mutateRuntimeData((data) => {
    const kilometerState = ensureKilometerState(data);
    const points = collectKilometerPoints(data);
    const pointMap = new Map(points.map((point) => [point.pointId, point]));

    const date = normalizeDateString(payload?.date);
    const fromPointId = String(payload?.fromPointId || '').trim();
    const toPointId = String(payload?.toPointId || '').trim();
    const note = String(payload?.note || '').trim();
    const km = Number(payload?.km);

    if (!fromPointId || !toPointId) throw new Error('Bitte Start- und Zielpunkt auswählen.');
    if (fromPointId === toPointId) throw new Error('Start- und Zielpunkt dürfen nicht identisch sein.');
    if (!Number.isFinite(km) || km <= 0) throw new Error('Bitte gültige Kilometer eingeben.');
    if (!note) throw new Error('Bitte eine Begründung eingeben.');

    const fromPoint = pointMap.get(fromPointId);
    const toPoint = pointMap.get(toPointId);
    if (!fromPoint || !toPoint) throw new Error('Ausgewählte Strecke ist ungültig.');

    kilometerState.travelLog.push({
      travelId: generateId('travel'),
      date,
      fromPointId,
      toPointId,
      fromLabel: fromPoint.label,
      toLabel: toPoint.label,
      km,
      source: 'manual',
      relatedEntryId: '',
      note,
      createdAt: new Date().toISOString()
    });
  });
}

export function updateKilometerTravel(travelId, payload) {
  mutateRuntimeData((data) => {
    const kilometerState = ensureKilometerState(data);
    const points = collectKilometerPoints(data);
    const pointMap = new Map(points.map((point) => [point.pointId, point]));

    const id = String(travelId || '').trim();
    if (!id) throw new Error('Fahrt nicht gefunden.');

    const item = (kilometerState.travelLog || []).find((row) => row.travelId === id);
    if (!item) throw new Error('Fahrt nicht gefunden.');

    const date = normalizeDateString(payload?.date);
    const fromPointId = String(payload?.fromPointId || '').trim();
    const toPointId = String(payload?.toPointId || '').trim();
    const note = String(payload?.note || '').trim();
    const km = Number(payload?.km);

    if (!fromPointId || !toPointId) throw new Error('Bitte Start- und Zielpunkt auswählen.');
    if (fromPointId === toPointId) throw new Error('Start- und Zielpunkt dürfen nicht identisch sein.');
    if (!Number.isFinite(km) || km <= 0) throw new Error('Bitte gültige Kilometer eingeben.');

    const fromPoint = pointMap.get(fromPointId);
    const toPoint = pointMap.get(toPointId);
    if (!fromPoint || !toPoint) throw new Error('Ausgewählte Strecke ist ungültig.');

    item.date = date;
    item.fromPointId = fromPointId;
    item.toPointId = toPointId;
    item.fromLabel = fromPoint.label;
    item.toLabel = toPoint.label;
    item.km = km;
    item.note = note;
    item.updatedAt = new Date().toISOString();
    item.manualAdjusted = true;
  });
}

export function deleteKilometerTravel(travelId) {
  mutateRuntimeData((data) => {
    const kilometerState = ensureKilometerState(data);
    const id = String(travelId || '').trim();
    if (!id) throw new Error('Fahrt nicht gefunden.');

    const before = kilometerState.travelLog.length;
    kilometerState.travelLog = kilometerState.travelLog.filter((item) => item.travelId !== id);

    if (kilometerState.travelLog.length === before) {
      throw new Error('Fahrt nicht gefunden.');
    }
  });
}

export function getKilometerPeriodSummary(fromDate, toDate) {
  const data = getRuntimeData();
  if (!data) throw new Error('Kein runtimeData Zustand vorhanden');
  const kilometerState = ensureKilometerState(data);
  const rows = (kilometerState.travelLog || [])
    .filter((item) => isDateInRange(item.date, fromDate, toDate))
    .sort((a, b) => compareDeDates(a?.date, b?.date) || String(a?.createdAt || '').localeCompare(String(b?.createdAt || ''), 'de'));

  const totalKm = rows.reduce((sum, item) => sum + (Number(item.km) || 0), 0);
  const totalAmount = totalKm * 0.3;

  return {
    fromDate: String(fromDate || '').trim(),
    toDate: String(toDate || '').trim(),
    rows,
    totalKm,
    totalAmount
  };
}


export function createHome({ name, adresse }) {
  mutateRuntimeData((data) => {
    data.homes.push({
      homeId: generateId("home"),
      name: name.trim(),
      adresse: adresse.trim(),
      patients: []
    });
  });
}

export function updateHomeAddress(homeId, adresse) {
  mutateRuntimeData((data) => {
    const home = getHomeById(data, homeId);
    if (!home) throw new Error("Heim nicht gefunden");
    home.adresse = String(adresse || "").trim();
  });
}

export function deleteHome(homeId) {
  mutateRuntimeData((data) => {
    const home = getHomeById(data, homeId);
    if (!home) throw new Error("Heim nicht gefunden");

    const patientIds = new Set((home.patients || []).map((patient) => String(patient?.patientId || "")).filter(Boolean));
    const entryIds = new Set();

    (home.patients || []).forEach((patient) => {
      (patient.rezepte || []).forEach((rezept) => {
        (rezept.entries || []).forEach((entry) => {
          const id = String(entry?.entryId || "").trim();
          if (id) entryIds.add(id);
        });
      });
    });

    ensureKilometerState(data);
    data.kilometer.travelLog = (data.kilometer.travelLog || []).filter((item) => {
      const relatedEntryId = String(item?.relatedEntryId || "").trim();
      const fromPointId = String(item?.fromPointId || "").trim();
      const toPointId = String(item?.toPointId || "").trim();

      if (relatedEntryId && entryIds.has(relatedEntryId)) return false;
      if (fromPointId === `home:${homeId}` || toPointId === `home:${homeId}`) return false;
      if ([fromPointId, toPointId].some((pointId) => pointId.startsWith('hb:') && patientIds.has(pointId.slice(3)))) return false;
      return true;
    });

    data.kilometer.knownRoutes = (data.kilometer.knownRoutes || []).filter((route) => {
      const fromPointId = String(route?.fromPointId || "").trim();
      const toPointId = String(route?.toPointId || "").trim();
      if (fromPointId === `home:${homeId}` || toPointId === `home:${homeId}`) return false;
      if ([fromPointId, toPointId].some((pointId) => pointId.startsWith('hb:') && patientIds.has(pointId.slice(3)))) return false;
      return true;
    });

    const beforeLength = (data.homes || []).length;
    data.homes = (data.homes || []).filter((item) => item.homeId !== homeId);

    if (data.homes.length === beforeLength) {
      throw new Error("Heim nicht gefunden");
    }
  });
}

export function getHomeById(data, homeId) {
  return (data.homes || []).find((home) => home.homeId === homeId) || null;
}

export function createPatient(homeId, payload) {
  mutateRuntimeData((data) => {
    const home = getHomeById(data, homeId);
    if (!home) throw new Error("Heim nicht gefunden");

    home.patients.push({
      patientId: generateId("patient"),
      firstName: (payload.firstName || "").trim(),
      lastName: (payload.lastName || "").trim(),
      birthDate: (payload.birthDate || "").trim(),
      befreit: !!payload.befreit,
      hb: !!payload.hb,
      verstorben: !!payload.verstorben,
      entries: [],
      rezepte: [],
      zeitMeta: {}
    });
  });
}


export function updatePatient(homeId, patientId, payload) {
  mutateRuntimeData((data) => {
    const home = getHomeById(data, homeId);
    if (!home) throw new Error("Heim nicht gefunden");

    const patient = getPatientById(home, patientId);
    if (!patient) throw new Error("Patient nicht gefunden");

    patient.firstName = String(payload.firstName || "").trim();
    patient.lastName = String(payload.lastName || "").trim();
    patient.birthDate = String(payload.birthDate || "").trim();
    patient.befreit = !!payload.befreit;
    patient.hb = !!payload.hb;
    patient.verstorben = !!payload.verstorben;
  });
}

export function getPatientById(home, patientId) {
  return (home?.patients || []).find((patient) => patient.patientId === patientId) || null;
}

export function createRezept(homeId, patientId, payload) {
  mutateRuntimeData((data) => {
    const home = getHomeById(data, homeId);
    if (!home) throw new Error("Heim nicht gefunden");

    const patient = getPatientById(home, patientId);
    if (!patient) throw new Error("Patient nicht gefunden");

    const items = (payload.items || [])
      .map((item) => ({
        itemId: generateId("item"),
        type: (item.type || "").trim(),
        count: item.type === "Blanko" ? "" : String(item.count || "").trim()
      }))
      .filter((item) => item.type);

    patient.rezepte.push({
      rezeptId: generateId("rezept"),
      arzt: (payload.arzt || "").trim(),
      ausstell: (payload.ausstell || "").trim(),
      bg: !!payload.bg,
      dt: !!payload.dt,
      items,
      entries: [],
      zeitMeta: {
        plannedTimeMinutes: 0,
        lastTimeEntryAt: "",
        kilometerRelevant: true
      },
      exportMeta: {
        exportReady: true,
        viewerLabel: "",
        lastExportAt: ""
      },
      timeEntries: [],
      doctorReports: []
    });
  });
}

export function updateRezept(homeId, patientId, rezeptId, payload) {
  mutateRuntimeData((data) => {
    const home = getHomeById(data, homeId);
    if (!home) throw new Error("Heim nicht gefunden");

    const patient = getPatientById(home, patientId);
    if (!patient) throw new Error("Patient nicht gefunden");

    const rezept = getRezeptById(patient, rezeptId);
    if (!rezept) throw new Error("Rezept nicht gefunden");

    const items = (payload.items || [])
      .map((item) => ({
        itemId: item.itemId || generateId("item"),
        type: (item.type || "").trim(),
        count: item.type === "Blanko" ? "" : String(item.count || "").trim()
      }))
      .filter((item) => item.type);

    rezept.arzt = (payload.arzt || "").trim();
    rezept.ausstell = (payload.ausstell || "").trim();
    rezept.bg = !!payload.bg;
    rezept.dt = !!payload.dt;
    rezept.items = items;

    if (!rezept.zeitMeta || typeof rezept.zeitMeta !== "object") {
      rezept.zeitMeta = {
        plannedTimeMinutes: 0,
        lastTimeEntryAt: "",
        kilometerRelevant: true
      };
    }

    if (!rezept.exportMeta || typeof rezept.exportMeta !== "object") {
      rezept.exportMeta = {
        exportReady: true,
        viewerLabel: "",
        lastExportAt: ""
      };
    }

    if (!Array.isArray(rezept.doctorReports)) {
      rezept.doctorReports = [];
    }

    ensureRezeptTimeState(rezept);
  });
}

export function deleteRezept(homeId, patientId, rezeptId) {
  mutateRuntimeData((data) => {
    const home = getHomeById(data, homeId);
    if (!home) throw new Error("Heim nicht gefunden");

    const patient = getPatientById(home, patientId);
    if (!patient) throw new Error("Patient nicht gefunden");

    const rezept = getRezeptById(patient, rezeptId);
    if (!rezept) throw new Error("Rezept nicht gefunden");

    ensureRezeptTimeState(rezept);

    const entryIds = new Set((rezept.entries || []).map((entry) => String(entry?.entryId || "")).filter(Boolean));
    const timeEntryIds = new Set((rezept.timeEntries || []).map((item) => String(item?.timeEntryId || "")).filter(Boolean));

    ensureKilometerState(data);
    data.kilometer.travelLog = (data.kilometer.travelLog || []).filter((item) => {
      const relatedEntryId = String(item?.relatedEntryId || "");
      return !relatedEntryId || !entryIds.has(relatedEntryId);
    });

    const beforeLength = patient.rezepte.length;
    patient.rezepte = patient.rezepte.filter((item) => item.rezeptId !== rezeptId);

    if (patient.rezepte.length === beforeLength) {
      throw new Error("Rezept nicht gefunden");
    }

    patient.rezepte.forEach((otherRezept) => {
      ensureRezeptTimeState(otherRezept);

      (otherRezept.entries || []).forEach((entry) => {
        if (timeEntryIds.has(String(entry?.linkedTimeEntryId || ""))) {
          entry.linkedTimeEntryId = "";
        }
      });

      otherRezept.timeEntries = (otherRezept.timeEntries || []).filter((item) =>
        !entryIds.has(String(item?.sourceEntryId || ""))
      );

      const lastTimeEntry = otherRezept.timeEntries
        .slice()
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];

      otherRezept.zeitMeta.lastTimeEntryAt = lastTimeEntry?.createdAt || "";
    });
  });
}

export function getRezeptById(patient, rezeptId) {
  return (patient?.rezepte || []).find((rezept) => rezept.rezeptId === rezeptId) || null;
}

export function createRezeptEntry(homeId, patientId, rezeptId, payload) {
  mutateRuntimeData((data) => {
    const home = getHomeById(data, homeId);
    if (!home) throw new Error("Heim nicht gefunden");

    const patient = getPatientById(home, patientId);
    if (!patient) throw new Error("Patient nicht gefunden");

    const rezept = getRezeptById(patient, rezeptId);
    if (!rezept) throw new Error("Rezept nicht gefunden");

    ensureRezeptTimeState(rezept);

    const entryId = generateId("entry");
    let linkedTimeEntryId = "";
    const entryDate = normalizeDateString(payload.date);
    const todayDate = getTodayDateString();
    const autoMinutes = getAutomaticTreatmentMinutes(rezept);
    const isTodayEntry = entryDate === todayDate;
    const alreadyCreditedToday = (rezept.timeEntries || []).some((item) => {
      const itemDate = normalizeDateString(item?.date);
      return item.type === "behandlung" && itemDate === entryDate;
    });

    if (isTodayEntry && autoMinutes > 0 && !alreadyCreditedToday) {
      const timeEntry = createTimeEntryObject({
        date: entryDate,
        minutes: autoMinutes,
        type: "behandlung",
        note: "Automatisch aus Dokumentation",
        sourceEntryId: entryId,
        confirmed: true
      });
      rezept.timeEntries.push(timeEntry);
      linkedTimeEntryId = timeEntry.timeEntryId;
      rezept.zeitMeta.lastTimeEntryAt = timeEntry.createdAt;
    }

    rezept.entries.push({
      entryId,
      date: entryDate,
      text: (payload.text || "").trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      linkedTimeEntryId,
      autoTimeMinutes: autoMinutes
    });

    appendTravelLogIfPossible(data, homeId, patientId, payload.date, entryId);
  });
}

export function updateRezeptEntry(homeId, patientId, rezeptId, entryId, payload) {
  mutateRuntimeData((data) => {
    const home = getHomeById(data, homeId);
    if (!home) throw new Error("Heim nicht gefunden");

    const patient = getPatientById(home, patientId);
    if (!patient) throw new Error("Patient nicht gefunden");

    const rezept = getRezeptById(patient, rezeptId);
    if (!rezept) throw new Error("Rezept nicht gefunden");

    const entry = (rezept.entries || []).find((item) => item.entryId === entryId);
    if (!entry) throw new Error("Eintrag nicht gefunden");

    entry.date = (payload.date || "").trim();
    entry.text = (payload.text || "").trim();
    entry.updatedAt = new Date().toISOString();
  });
}

export function deleteRezeptEntry(homeId, patientId, rezeptId, entryId) {
  mutateRuntimeData((data) => {
    const home = getHomeById(data, homeId);
    if (!home) throw new Error("Heim nicht gefunden");

    const patient = getPatientById(home, patientId);
    if (!patient) throw new Error("Patient nicht gefunden");

    const rezept = getRezeptById(patient, rezeptId);
    if (!rezept) throw new Error("Rezept nicht gefunden");

    ensureRezeptTimeState(rezept);

    const entry = (rezept.entries || []).find((item) => item.entryId === entryId);
    if (!entry) throw new Error("Eintrag nicht gefunden");

    rezept.entries = (rezept.entries || []).filter((item) => item.entryId !== entryId);

    if (entry.linkedTimeEntryId) {
      rezept.timeEntries = (rezept.timeEntries || []).filter((item) => item.timeEntryId !== entry.linkedTimeEntryId);
    }

    ensureKilometerState(data);
    data.kilometer.travelLog = (data.kilometer.travelLog || []).filter((item) => String(item?.relatedEntryId || "") !== entryId);

    const lastTimeEntry = (rezept.timeEntries || [])
      .slice()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];

    rezept.zeitMeta.lastTimeEntryAt = lastTimeEntry?.createdAt || "";
  });
}

export function rezeptSummary(rezept) {
  const items = rezept?.items || [];
  const parts = items.map((item) => {
    if (item.type === "Blanko") return "Blanko";
    return item.count ? `${item.type} ${item.count}x` : item.type;
  });

  let suffix = "";
  if (rezept?.dt) suffix += " · Doppeltermin";
  if (rezept?.bg) suffix += " · BG";

  return `${parts.join(", ") || "Keine Leistung"}${suffix}`;
}

export function searchPatientsInHome(home, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return home?.patients || [];

  return (home?.patients || []).filter((patient) => {
    const haystack = [
      patient.firstName || "",
      patient.lastName || "",
      patient.birthDate || ""
    ].join(" ").toLowerCase();

    return haystack.includes(q);
  });
}

function comparePatientsByLastName(a, b) {
  const last = String(a?.patientLastName || "").localeCompare(String(b?.patientLastName || ""), "de");
  if (last !== 0) return last;
  const first = String(a?.patientFirstName || "").localeCompare(String(b?.patientFirstName || ""), "de");
  if (first !== 0) return first;
  const displayA = String(a?.patient || a?.patientName || "");
  const displayB = String(b?.patient || b?.patientName || "");
  return displayA.localeCompare(displayB, "de");
}

function buildAbgabeLeistungText(rezept) {
  const parts = (rezept?.items || []).map((item) => {
    if (!item) return "";
    if (item.type === "Blanko") return "Blanko";
    return item.count ? `${item.type} ${item.count}x` : (item.type || "");
  }).filter(Boolean);

  return parts.join(", ");
}

export function buildAbgabeRows(data) {
  const rows = [];

  (data.homes || []).forEach((home) => {
    (home.patients || []).forEach((patient) => {
      (patient.rezepte || []).forEach((rezept) => {
        rows.push({
          rowId: `${home.homeId}_${patient.patientId}_${rezept.rezeptId}`,
          heim: home.name || "",
          patient: `${patient.lastName || ""}, ${patient.firstName || ""}`.replace(/^,\s*/, "").trim(),
          patientFirstName: patient.firstName || "",
          patientLastName: patient.lastName || "",
          geb: patient.birthDate || "",
          ausstell: getRezeptAusstellungsdatum(rezept),
          leistung: buildAbgabeLeistungText(rezept),
          anzahl: "",
          menge: "",
          arzt: rezept.arzt || rezept.doctor || "",
          befreit: !!patient.befreit,
          bg: !!rezept.bg,
          dt: !!rezept.dt,
          rezeptId: rezept.rezeptId,
          patientId: patient.patientId,
          homeId: home.homeId
        });
      });
    });
  });

  return rows.sort((a, b) => {
    const last = String(a.patientLastName || "").localeCompare(String(b.patientLastName || ""), "de");
    if (last !== 0) return last;
    const first = String(a.patientFirstName || "").localeCompare(String(b.patientFirstName || ""), "de");
    if (first !== 0) return first;
    const homeCompare = String(a.heim || "").localeCompare(String(b.heim || ""), "de");
    if (homeCompare !== 0) return homeCompare;
    return String(a.leistung || "").localeCompare(String(b.leistung || ""), "de");
  });
}

export function filterAbgabeRows(rows, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return rows;

  return rows.filter((row) => {
    const haystack = [
      row.heim,
      row.patient,
      row.geb,
      row.ausstell,
      row.leistung,
      row.anzahl,
      row.arzt
    ].join(" ").toLowerCase();

    return haystack.includes(q);
  });
}


function findNachbestellContext(data, row) {
  const home = (data.homes || []).find((item) => item.homeId === row.homeId);
  const patient = (home?.patients || []).find((item) => item.patientId === row.patientId);
  const rezept = (patient?.rezepte || []).find((item) => item.rezeptId === row.rezeptId);
  return { home, patient, rezept };
}

export function buildNachbestellLetterData(data, rows) {
  const safeRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (safeRows.length === 0) {
    throw new Error('Bitte mindestens ein Rezept auswählen.');
  }

  const doctors = Array.from(new Set(safeRows.map((row) => String(row.doctor || '').trim()).filter(Boolean)));
  if (doctors.length !== 1) {
    throw new Error('Es kann nur ein Nachbestellzettel pro Arzt erzeugt werden.');
  }

  const doctor = doctors[0];
  const settings = data?.settings && typeof data.settings === 'object' ? data.settings : {};
  const groups = new Map();
  let rezeptCount = 0;
  let patientCount = 0;

  safeRows.forEach((row) => {
    const { home, patient, rezept } = findNachbestellContext(data, row);
    if (!home || !patient || !rezept) return;

    const isHausbesuch = !!patient.hb;
    const groupKey = isHausbesuch ? '__hausbesuch__' : `home:${home.homeId}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        groupKey,
        type: isHausbesuch ? 'hausbesuch' : 'heim',
        title: isHausbesuch ? 'Hausbesuch' : String(home.name || '').trim(),
        address: isHausbesuch
          ? String(settings.practiceAddress || '').trim()
          : String(home.adresse || '').trim(),
        patients: new Map()
      });
    }

    const group = groups.get(groupKey);
    if (!group.patients.has(patient.patientId)) {
      group.patients.set(patient.patientId, {
        patientId: patient.patientId,
        patientName: `${String(patient.lastName || '').trim()}, ${String(patient.firstName || '').trim()}`.replace(/^,\s*/, '').trim(),
        geb: String(patient.birthDate || '').trim(),
        rezepte: []
      });
      patientCount += 1;
    }

    group.patients.get(patient.patientId).rezepte.push({
      rezeptId: rezept.rezeptId,
      text: `${rezeptSummary(rezept)} + HB`
    });
    rezeptCount += 1;
  });

  const normalizedGroups = Array.from(groups.values())
    .map((group) => ({
      ...group,
      patients: Array.from(group.patients.values())
        .map((patient) => ({
          ...patient,
          rezepte: patient.rezepte.sort((a, b) => String(a.text || '').localeCompare(String(b.text || ''), 'de'))
        }))
        .sort(comparePatientsByLastName)
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'heim' ? -1 : 1;
      return `${a.title} ${a.address}`.localeCompare(`${b.title} ${b.address}`, 'de');
    });

  return {
    createdAt: new Date().toISOString(),
    doctor,
    title: `Nachbestellung ${doctor}`,
    praxis: {
      name: 'Physio Strobl',
      department: 'Abteilung FaSt',
      address: String(settings.practiceAddress || '').trim(),
      phone: String(settings.practicePhone || '').trim(),
      fax: String(settings.therapistFax || '').trim(),
      therapistName: String(settings.therapistName || '').trim()
    },
    groups: normalizedGroups,
    patientCount,
    rezeptCount
  };
}

export function saveNachbestellHistorySnapshot(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  mutateRuntimeData((data) => {
    data.nachbestellHistory.unshift({
      id: generateId('nachbestellung'),
      createdAt: String(source.createdAt || new Date().toISOString()),
      title: String(source.title || 'Nachbestellung').trim(),
      doctor: String(source.doctor || '').trim(),
      rezeptCount: Number.isFinite(Number(source.rezeptCount)) ? Number(source.rezeptCount) : 0,
      patientCount: Number.isFinite(Number(source.patientCount)) ? Number(source.patientCount) : 0,
      snapshotHtml: String(source.snapshotHtml || ''),
      lines: Array.isArray(source.lines) ? source.lines.map((line) => ({
        patient: String(line?.patient || '').trim(),
        geb: String(line?.geb || '').trim(),
        heim: String(line?.heim || '').trim(),
        text: String(line?.text || '').trim()
      })) : []
    });
  });
}


export function deleteNachbestellHistoryItem(historyId) {
  const targetId = String(historyId || '').trim();
  if (!targetId) return;
  mutateRuntimeData((data) => {
    data.nachbestellHistory = (data.nachbestellHistory || []).filter((item) => item.id !== targetId);
  });
}

export function buildNachbestellRows(data) {
  const rows = [];

  (data.homes || []).forEach((home) => {
    (home.patients || []).forEach((patient) => {
      (patient.rezepte || []).forEach((rezept) => {
        rows.push({
          rowId: `${home.homeId}_${patient.patientId}_${rezept.rezeptId}`,
          doctor: rezept.arzt || "",
          patient: `${patient.firstName || ""} ${patient.lastName || ""}`.trim(),
          patientFirstName: patient.firstName || "",
          patientLastName: patient.lastName || "",
          geb: patient.birthDate || "",
          heim: home.name || "",
          text: rezeptSummary(rezept),
          ausstell: getRezeptAusstellungsdatum(rezept),
          rezeptId: rezept.rezeptId,
          patientId: patient.patientId,
          homeId: home.homeId
        });
      });
    });
  });

  return rows.sort((a, b) => {
    const patientCompare = comparePatientsByLastName(a, b);
    if (patientCompare !== 0) return patientCompare;
    const homeCompare = String(a.heim || "").localeCompare(String(b.heim || ""), "de");
    if (homeCompare !== 0) return homeCompare;
    return String(a.text || "").localeCompare(String(b.text || ""), "de");
  });
}

export function filterNachbestellRows(rows, doctorQuery, textQuery = "") {
  const dq = String(doctorQuery || "").trim().toLowerCase();
  const tq = String(textQuery || "").trim().toLowerCase();

  return rows.filter((row) => {
    const doctorOk = !dq || String(row.doctor || "").toLowerCase().includes(dq);
    const textOk = !tq || [
      row.doctor,
      row.patient,
      row.geb,
      row.heim,
      row.text
    ].join(" ").toLowerCase().includes(tq);

    return doctorOk && textOk;
  });
}

export function getDoctorList(data) {
  const set = new Set();

  (data.homes || []).forEach((home) => {
    (home.patients || []).forEach((patient) => {
      (patient.rezepte || []).forEach((rezept) => {
        const arzt = String(rezept.arzt || "").trim();
        if (arzt) set.add(arzt);
      });
    });
  });

  return Array.from(set).sort((a, b) => a.localeCompare(b, "de"));
}

export function saveAbgabeHistory(title, rows, options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  mutateRuntimeData((data) => {
    data.abgabeHistory.unshift({
      id: generateId("abgabe"),
      createdAt: String(source.createdAt || new Date().toISOString()),
      title: title || "Abgabeliste",
      snapshotHtml: String(source.snapshotHtml || ""),
      rows: rows.map((row) => ({
        heim: row.heim || "",
        patient: row.patient || "",
        patientFirstName: row.patientFirstName || "",
        patientLastName: row.patientLastName || "",
        geb: row.geb || "",
        ausstell: row.ausstell || "",
        leistung: row.leistung || "",
        anzahl: row.anzahl || "",
        menge: row.menge || "",
        arzt: row.arzt || "",
        befreit: !!row.befreit,
        bg: !!row.bg,
        dt: !!row.dt
      }))
    });
  });
}

export function deleteAbgabeHistoryItem(historyId) {
  const targetId = String(historyId || '').trim();
  if (!targetId) return;
  mutateRuntimeData((data) => {
    data.abgabeHistory = (data.abgabeHistory || []).filter((item) => item.id !== targetId);
  });
}

export function saveNachbestellHistory(title, doctor, rows) {
  mutateRuntimeData((data) => {
    data.nachbestellHistory.unshift({
      id: generateId("nachbestellung"),
      createdAt: new Date().toISOString(),
      title: title || "Nachbestellung",
      doctor: doctor || "",
      lines: rows.map((row) => ({
        patient: row.patient || "",
        geb: row.geb || "",
        heim: row.heim || "",
        text: row.text || ""
      }))
    });
  });
}

export function buildAbgabeTree(data) {
  const homes = [];

  (data.homes || []).forEach((home) => {
    const patients = [];

    (home.patients || []).forEach((patient) => {
      const rezepte = [];

      (patient.rezepte || []).forEach((rezept) => {
        rezepte.push({
          rowId: `${home.homeId}_${patient.patientId}_${rezept.rezeptId}`,
          rezeptId: rezept.rezeptId,
          arzt: rezept.arzt || rezept.doctor || "",
          ausstell: rezept.ausstell || "",
          bg: !!rezept.bg,
          dt: !!rezept.dt,
          leistung: buildAbgabeLeistungText(rezept),
          anzahl: "",
          menge: ""
        });
      });

      if (rezepte.length > 0) {
        patients.push({
          patientId: patient.patientId,
          patientName: `${patient.lastName || ""}, ${patient.firstName || ""}`.replace(/^,\s*/, "").trim(),
          patientFirstName: patient.firstName || "",
          patientLastName: patient.lastName || "",
          geb: patient.birthDate || "",
          befreit: !!patient.befreit,
          rezepte
        });
      }
    });

    if (patients.length > 0) {
      homes.push({
        homeId: home.homeId,
        homeName: home.name || "",
        patients: patients.sort((a, b) => {
          const last = String(a.patientLastName || "").localeCompare(String(b.patientLastName || ""), "de");
          if (last !== 0) return last;
          return String(a.patientFirstName || "").localeCompare(String(b.patientFirstName || ""), "de");
        })
      });
    }
  });

  return homes.sort((a, b) => String(a.homeName).localeCompare(String(b.homeName), "de"));
}

export function buildNachbestellTree(data, doctorFilter = "", textFilter = "") {
  const filtered = filterNachbestellRows(buildNachbestellRows(data), doctorFilter, textFilter);
  const map = new Map();

  filtered.forEach((row) => {
    const doctorKey = row.doctor || "Ohne Arzt";

    if (!map.has(doctorKey)) {
      map.set(doctorKey, {
        doctor: doctorKey,
        patients: new Map()
      });
    }

    const doctorGroup = map.get(doctorKey);
    const patientKey = `${row.heim}__${row.patient}__${row.geb}`;

    if (!doctorGroup.patients.has(patientKey)) {
      doctorGroup.patients.set(patientKey, {
        patient: row.patient || "",
        patientFirstName: row.patientFirstName || "",
        patientLastName: row.patientLastName || "",
        geb: row.geb || "",
        heim: row.heim || "",
        rows: []
      });
    }

    doctorGroup.patients.get(patientKey).rows.push(row);
  });

  return Array.from(map.values())
    .map((group) => ({
      doctor: group.doctor,
      patients: Array.from(group.patients.values()).sort(comparePatientsByLastName)
    }))
    .sort((a, b) => String(a.doctor).localeCompare(String(b.doctor), "de"));
}


export function createRezeptTimeEntry(homeId, patientId, rezeptId, payload) {
  mutateRuntimeData((data) => {
    const home = getHomeById(data, homeId);
    if (!home) throw new Error("Heim nicht gefunden");

    const patient = getPatientById(home, patientId);
    if (!patient) throw new Error("Patient nicht gefunden");

    const rezept = getRezeptById(patient, rezeptId);
    if (!rezept) throw new Error("Rezept nicht gefunden");

    ensureRezeptTimeState(rezept);

    const timeEntry = createTimeEntryObject({
      ...payload,
      type: "besprechung",
      confirmed: true
    });

    if (!timeEntry.minutes) {
      throw new Error("Besprechungszeit muss größer als 0 Minuten sein");
    }

    rezept.timeEntries.push(timeEntry);
    rezept.zeitMeta.lastTimeEntryAt = timeEntry.createdAt;
  });
}



export function deleteRezeptTimeEntry(homeId, patientId, rezeptId, timeEntryId) {
  mutateRuntimeData((data) => {
    const home = getHomeById(data, homeId);
    if (!home) throw new Error("Heim nicht gefunden");

    const patient = getPatientById(home, patientId);
    if (!patient) throw new Error("Patient nicht gefunden");

    const rezept = getRezeptById(patient, rezeptId);
    if (!rezept) throw new Error("Rezept nicht gefunden");

    ensureRezeptTimeState(rezept);

    const beforeLength = rezept.timeEntries.length;
    rezept.timeEntries = rezept.timeEntries.filter((item) => item.timeEntryId !== timeEntryId);

    if (rezept.timeEntries.length === beforeLength) {
      throw new Error("Zeiteintrag nicht gefunden");
    }

    (rezept.entries || []).forEach((entry) => {
      if (entry.linkedTimeEntryId === timeEntryId) {
        entry.linkedTimeEntryId = "";
      }
    });

    const lastTimeEntry = rezept.timeEntries
      .slice()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];

    rezept.zeitMeta.lastTimeEntryAt = lastTimeEntry?.createdAt || "";
  });
}

export function getRezeptTimeEntries(rezept) {
  return [...(rezept?.timeEntries || [])].sort((a, b) =>
    compareDeDates(String(b?.date || ""), String(a?.date || ""))
    || String(b?.createdAt || "").localeCompare(String(a?.createdAt || ""), "de")
  );
}

export function getRezeptTimeSummary(rezept) {
  const entries = rezept?.timeEntries || [];
  const totalMinutes = entries.reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
  const totalEntries = entries.length;
  return { totalMinutes, totalEntries };
}

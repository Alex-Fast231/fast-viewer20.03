const state = {
  datasets: [],
  selectedTherapistKey: "",
  selectedTab: "zeit",
  filters: {
    from: "",
    to: ""
  }
};

const el = {
  backupFiles: document.getElementById("backupFiles"),
  masterkey: document.getElementById("masterkey"),
  loadBtn: document.getElementById("loadBtn"),
  clearBtn: document.getElementById("clearBtn"),
  loadMessage: document.getElementById("loadMessage"),
  therapistList: document.getElementById("therapistList"),
  mainContent: document.getElementById("mainContent")
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fromBase64(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function textToUint8(text) {
  return new TextEncoder().encode(String(text ?? ""));
}

function uint8ToText(bytes) {
  return new TextDecoder().decode(bytes);
}

async function deriveKey(secret, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey("raw", textToUint8(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: 250000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function decryptJSON(payload, cryptoKey) {
  const iv = fromBase64(payload.ivBase64);
  const cipherBytes = fromBase64(payload.cipherBase64);
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, cipherBytes);
  return JSON.parse(uint8ToText(new Uint8Array(plainBuffer)));
}

async function importKeyRaw(rawKeyBytes) {
  return crypto.subtle.importKey("raw", rawKeyBytes, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function unwrapDataKeyWithPassword(wrappedPayload, password, passwordSaltBytes) {
  const passwordKey = await deriveKey(password, passwordSaltBytes);
  const result = await decryptJSON(
    {
      ivBase64: wrappedPayload.ivBase64,
      cipherBase64: wrappedPayload.wrappedKeyBase64
    },
    passwordKey
  );
  return importKeyRaw(fromBase64(result.rawKeyBase64));
}

function createId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function ensureString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function ensureBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeDateString(value) {
  const text = ensureString(value).trim();
  if (!text) return "";
  const isoLike = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoLike) return `${isoLike[1]}-${isoLike[2]}-${isoLike[3]}`;
  const deLike = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (deLike) return `${deLike[3]}-${deLike[2].padStart(2, "0")}-${deLike[1].padStart(2, "0")}`;
  return text;
}

function formatDate(value) {
  const iso = normalizeDateString(value);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return value || "—";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getRezeptAusstellungsdatum(source) {
  const item = source && typeof source === "object" ? source : {};
  return ensureString(
    item.ausstell || item.ausstellungsdatum || item.issueDate || item.datum || item.verordnungsdatum
  ).trim();
}

function normalizeEntry(entry) {
  const now = new Date().toISOString();
  const item = entry && typeof entry === "object" ? entry : {};
  return {
    entryId: ensureString(item.entryId) || createId("entry"),
    date: normalizeDateString(item.date),
    text: ensureString(item.text),
    createdAt: ensureString(item.createdAt, now),
    updatedAt: ensureString(item.updatedAt, now),
    linkedTimeEntryId: ensureString(item.linkedTimeEntryId),
    autoTimeMinutes: Number.isFinite(Number(item.autoTimeMinutes)) ? Number(item.autoTimeMinutes) : 0
  };
}

function normalizeItem(item) {
  const source = item && typeof item === "object" ? item : {};
  const type = ensureString(source.type).trim();
  if (!type) return null;
  return {
    itemId: ensureString(source.itemId) || createId("item"),
    type,
    count: type === "Blanko" ? "" : ensureString(source.count)
  };
}

function normalizeRezept(rezept) {
  const source = rezept && typeof rezept === "object" ? rezept : {};
  let items = [];
  if (Array.isArray(source.items)) {
    items = source.items.map(normalizeItem).filter(Boolean);
  } else {
    const leistung = ensureString(source.leistung).trim();
    if (leistung) items = [{ itemId: createId("item"), type: leistung, count: ensureString(source.anzahl) }];
  }

  return {
    rezeptId: ensureString(source.rezeptId || source.id) || createId("rezept"),
    arzt: ensureString(source.arzt || source.doctor),
    ausstell: getRezeptAusstellungsdatum(source),
    status: ensureString(source.status || "Aktiv") || "Aktiv",
    bg: ensureBoolean(source.bg, false),
    dt: ensureBoolean(source.dt, false),
    items,
    entries: ensureArray(source.entries).map(normalizeEntry),
    timeEntries: ensureArray(source.timeEntries).map((item) => {
      const now = new Date().toISOString();
      const row = item && typeof item === "object" ? item : {};
      return {
        timeEntryId: ensureString(row.timeEntryId) || createId("time"),
        date: normalizeDateString(row.date),
        minutes: Number.isFinite(Number(row.minutes)) ? Number(row.minutes) : 0,
        type: ensureString(row.type || "behandlung") || "behandlung",
        note: ensureString(row.note),
        sourceEntryId: ensureString(row.sourceEntryId),
        confirmed: ensureBoolean(row.confirmed, true),
        createdAt: ensureString(row.createdAt, now),
        updatedAt: ensureString(row.updatedAt, now)
      };
    })
  };
}

function normalizePatient(patient) {
  const source = patient && typeof patient === "object" ? patient : {};
  return {
    patientId: ensureString(source.patientId || source.id) || createId("patient"),
    firstName: ensureString(source.firstName),
    lastName: ensureString(source.lastName),
    birthDate: ensureString(source.birthDate),
    rezepte: ensureArray(source.rezepte).map(normalizeRezept)
  };
}

function normalizeHome(home) {
  const source = home && typeof home === "object" ? home : {};
  return {
    homeId: ensureString(source.homeId || source.id) || createId("home"),
    name: ensureString(source.name),
    adresse: ensureString(source.adresse || source.address),
    patients: ensureArray(source.patients).map(normalizePatient)
  };
}

function normalizeTravelLog(kilometerState) {
  const source = kilometerState && typeof kilometerState === "object" ? kilometerState : {};
  return ensureArray(source.travelLog).map((item) => ({
    travelId: ensureString(item?.travelId) || createId("travel"),
    date: normalizeDateString(item?.date),
    fromLabel: ensureString(item?.fromLabel),
    toLabel: ensureString(item?.toLabel),
    km: Number.isFinite(Number(item?.km)) ? Number(item.km) : 0,
    source: ensureString(item?.source, "auto") || "auto",
    relatedEntryId: ensureString(item?.relatedEntryId),
    note: ensureString(item?.note),
    createdAt: ensureString(item?.createdAt),
    updatedAt: ensureString(item?.updatedAt),
    manualAdjusted: Boolean(item?.manualAdjusted)
  }));
}

function normalizeAppData(data) {
  const source = data && typeof data === "object" ? data : {};
  const settings = source.settings && typeof source.settings === "object" ? source.settings : {};
  return {
    settings: {
      therapistId: ensureString(settings.therapistId || settings.userId || ""),
      therapistName: ensureString(settings.therapistName),
      therapistFax: ensureString(settings.therapistFax),
      practicePhone: ensureString(settings.practicePhone),
      practiceAddress: ensureString(settings.practiceAddress)
    },
    homes: ensureArray(source.homes).map(normalizeHome),
    kilometer: {
      travelLog: normalizeTravelLog(source.kilometer)
    },
    meta: source.meta && typeof source.meta === "object" ? source.meta : {},
    raw: source
  };
}

function rezeptSummary(rezept) {
  const parts = (rezept?.items || []).map((item) => {
    if (!item) return "";
    if (item.type === "Blanko") return "Blanko";
    return item.count ? `${item.type} ${item.count}x` : item.type;
  }).filter(Boolean);

  let suffix = "";
  if (rezept?.dt) suffix += " · Doppeltermin";
  if (rezept?.bg) suffix += " · BG";
  return `${parts.join(", ") || "Keine Leistung"}${suffix}`;
}

function getPatientName(patient) {
  return [ensureString(patient?.lastName), ensureString(patient?.firstName)].filter(Boolean).join(", ") || "—";
}

function extractDocuments(data, datasetId, exportTimestamp) {
  const rows = [];
  (data.homes || []).forEach((home) => {
    (home.patients || []).forEach((patient) => {
      (patient.rezepte || []).forEach((rezept) => {
        (rezept.entries || []).forEach((entry) => {
          rows.push({
            uniqueKey: `${datasetId}:doc:${entry.entryId}`,
            datasetId,
            exportTimestamp,
            entryId: entry.entryId,
            date: normalizeDateString(entry.date),
            text: entry.text || "",
            autoTimeMinutes: Number(entry.autoTimeMinutes || 0),
            homeId: home.homeId,
            homeName: home.name || "—",
            patientId: patient.patientId,
            patientName: getPatientName(patient),
            birthDate: patient.birthDate || "",
            rezeptId: rezept.rezeptId,
            rezeptLabel: rezeptSummary(rezept),
            rezeptStatus: rezept.status || "",
            arzt: rezept.arzt || "",
            ausstell: rezept.ausstell || "",
            linkedTimeEntryId: entry.linkedTimeEntryId || ""
          });
        });
      });
    });
  });
  return rows;
}

function extractTimeEntries(data, datasetId, exportTimestamp) {
  const rows = [];
  (data.homes || []).forEach((home) => {
    (home.patients || []).forEach((patient) => {
      (patient.rezepte || []).forEach((rezept) => {
        (rezept.timeEntries || []).forEach((entry) => {
          rows.push({
            uniqueKey: `${datasetId}:time:${entry.timeEntryId}`,
            datasetId,
            exportTimestamp,
            timeEntryId: entry.timeEntryId,
            sourceEntryId: entry.sourceEntryId || "",
            date: normalizeDateString(entry.date),
            minutes: Number(entry.minutes || 0),
            type: entry.type || "",
            note: entry.note || "",
            confirmed: entry.confirmed !== false,
            createdAt: entry.createdAt || "",
            updatedAt: entry.updatedAt || "",
            homeId: home.homeId,
            homeName: home.name || "—",
            patientId: patient.patientId,
            patientName: getPatientName(patient),
            birthDate: patient.birthDate || "",
            rezeptId: rezept.rezeptId,
            rezeptLabel: rezeptSummary(rezept),
            arzt: rezept.arzt || "",
            ausstell: rezept.ausstell || ""
          });
        });
      });
    });
  });
  return rows;
}

function extractTravelEntries(data, datasetId, exportTimestamp) {
  return (data.kilometer?.travelLog || []).map((item) => ({
    uniqueKey: `${datasetId}:travel:${item.travelId}`,
    datasetId,
    exportTimestamp,
    travelId: item.travelId,
    relatedEntryId: item.relatedEntryId || "",
    date: normalizeDateString(item.date),
    fromLabel: item.fromLabel || "—",
    toLabel: item.toLabel || "—",
    km: Number(item.km || 0),
    source: item.source || "auto",
    note: item.note || "",
    manualAdjusted: Boolean(item.manualAdjusted),
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || ""
  }));
}

function dedupeByStableId(rows, keyCandidates) {
  const map = new Map();
  rows.forEach((row) => {
    const stableKey = keyCandidates.map((field) => row[field] || "").join("|") || row.uniqueKey;
    const existing = map.get(stableKey);
    if (!existing) {
      map.set(stableKey, row);
      return;
    }
    const existingTs = String(existing.exportTimestamp || "");
    const nextTs = String(row.exportTimestamp || "");
    if (nextTs >= existingTs) map.set(stableKey, row);
  });
  return Array.from(map.values());
}

function matchesDateFilter(dateValue, from, to) {
  const date = normalizeDateString(dateValue);
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

async function parseBackupFile(file, password) {
  const reader = new zip.ZipReader(new zip.BlobReader(file));
  try {
    const entries = await reader.getEntries();
    const entryMap = new Map(entries.map((entry) => [entry.filename, entry]));
    const appEntry = entryMap.get("appData.enc");
    const cryptoEntry = entryMap.get("cryptoMeta.json");
    const metaEntry = entryMap.get("meta.json");

    if (!appEntry || !cryptoEntry || !metaEntry) {
      throw new Error(`${file.name}: Backup unvollständig`);
    }

    let encryptedAppData;
    let cryptoMeta;
    let meta;
    try {
      encryptedAppData = JSON.parse(await appEntry.getData(new zip.TextWriter(), { password }));
      cryptoMeta = JSON.parse(await cryptoEntry.getData(new zip.TextWriter(), { password }));
      meta = JSON.parse(await metaEntry.getData(new zip.TextWriter(), { password }));
    } catch {
      throw new Error(`${file.name}: Falscher Masterkey oder ZIP nicht lesbar`);
    }

    const dataKey = await unwrapDataKeyWithPassword(
      cryptoMeta.wrappedDataKeyByPassword,
      password,
      fromBase64(cryptoMeta.passwordSaltBase64)
    );
    const appData = await decryptJSON(encryptedAppData, dataKey);
    const normalizedData = normalizeAppData(appData);

    const therapistId = ensureString(
      meta.therapistId || normalizedData.settings.therapistId || normalizedData.raw?.therapistId || ""
    ).trim();
    const therapistName = ensureString(
      meta.therapistName || normalizedData.settings.therapistName || file.name.replace(/\.zip$/i, "")
    ).trim() || "Unbekannt";
    const therapistKey = therapistId || therapistName.toLowerCase();
    const exportTimestamp = meta.exportTimestamp || new Date(file.lastModified || Date.now()).toISOString();

    return {
      datasetId: createId("backup"),
      fileName: file.name,
      therapistId,
      therapistKey,
      therapistName,
      exportTimestamp,
      meta,
      data: normalizedData,
      docs: extractDocuments(normalizedData, file.name, exportTimestamp),
      timeEntries: extractTimeEntries(normalizedData, file.name, exportTimestamp),
      travelEntries: extractTravelEntries(normalizedData, file.name, exportTimestamp)
    };
  } catch (error) {
    if (String(error?.message || "").includes(file.name)) throw error;
    throw new Error(`${file.name}: ${String(error?.message || error)}`);
  } finally {
    await reader.close();
  }
}

function getTherapistGroups() {
  const map = new Map();
  state.datasets.forEach((dataset) => {
    const key = dataset.therapistKey;
    if (!map.has(key)) {
      map.set(key, {
        therapistKey: key,
        therapistId: dataset.therapistId,
        therapistName: dataset.therapistName,
        backups: []
      });
    }
    map.get(key).backups.push(dataset);
  });

  const groups = Array.from(map.values()).map((group) => {
    group.backups.sort((a, b) => String(b.exportTimestamp).localeCompare(String(a.exportTimestamp)));
    group.docs = dedupeByStableId(group.backups.flatMap((item) => item.docs), ["entryId"]);
    group.timeEntries = dedupeByStableId(group.backups.flatMap((item) => item.timeEntries), ["timeEntryId"]);
    group.travelEntries = dedupeByStableId(group.backups.flatMap((item) => item.travelEntries), ["travelId"]);
    group.stats = {
      backupCount: group.backups.length,
      docs: group.docs.length,
      timeEntries: group.timeEntries.length,
      kilometerRows: group.travelEntries.length,
      totalMinutes: group.timeEntries.reduce((sum, item) => sum + Number(item.minutes || 0), 0),
      totalKilometers: group.travelEntries.reduce((sum, item) => sum + Number(item.km || 0), 0)
    };
    return group;
  });

  groups.sort((a, b) => String(a.therapistName).localeCompare(String(b.therapistName), "de"));
  return groups;
}

function getSelectedGroup() {
  return getTherapistGroups().find((group) => group.therapistKey === state.selectedTherapistKey) || null;
}

function filterRows(rows) {
  return rows
    .filter((row) => matchesDateFilter(row.date, state.filters.from, state.filters.to))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""), "de") || String(b.createdAt || "").localeCompare(String(a.createdAt || ""), "de"));
}

function minutesToHourText(minutes) {
  const total = Number(minutes || 0);
  return `${(total / 60).toFixed(2).replace(".", ",")} h`;
}

function kilometerEuroText(km) {
  const amount = Number(km || 0) * 0.30;
  return `${amount.toFixed(2).replace(".", ",")} €`;
}

function renderTherapistList() {
  const groups = getTherapistGroups();
  if (!groups.length) {
    el.therapistList.innerHTML = `<div class="muted small">Nach dem Import erscheinen hier die Therapeuten.</div>`;
    return;
  }

  el.therapistList.innerHTML = groups.map((group) => `
    <button class="therapist-btn ${group.therapistKey === state.selectedTherapistKey ? "active" : ""}" data-therapist-key="${escapeHtml(group.therapistKey)}">
      <strong>${escapeHtml(group.therapistName)}</strong>
      <span class="therapist-meta">
        ${group.therapistId ? `ID: ${escapeHtml(group.therapistId)}<br>` : ""}
        ${group.backups.length} Backup(s) · ${group.docs.length} Doku · ${minutesToHourText(group.stats.totalMinutes)}
      </span>
    </button>
  `).join("");

  el.therapistList.querySelectorAll("[data-therapist-key]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTherapistKey = button.getAttribute("data-therapist-key") || "";
      render();
    });
  });
}

function renderBackupCards(backups) {
  return backups.map((item) => `
    <div class="backup-card">
      <strong>${escapeHtml(item.fileName)}</strong>
      <div class="small muted">Export: ${escapeHtml(formatDateTime(item.exportTimestamp))}</div>
      <div class="pills" style="margin-top:8px">
        <span class="pill">${item.docs.length} Doku</span>
        <span class="pill">${item.timeEntries.length} Zeiteinträge</span>
        <span class="pill">${item.travelEntries.length} Fahrten</span>
      </div>
    </div>
  `).join("");
}

function getTabLabel(tab) {
  if (tab === "doku") return "Patienten mit Dokumentation";
  if (tab === "kilometer") return "Kilometer";
  return "Geleistete Zeit";
}

function getCurrentFilteredRows(group) {
  const filteredTime = filterRows(group.timeEntries);
  const filteredDocs = filterRows(group.docs);
  const filteredKm = filterRows(group.travelEntries);
  return {
    filteredTime,
    filteredDocs,
    filteredKm,
    currentRows: state.selectedTab === "zeit" ? filteredTime : state.selectedTab === "doku" ? filteredDocs : filteredKm
  };
}

function renderZeitTable(rows) {
  if (!rows.length) return `<div class="empty">Keine Zeiteinträge im gewählten Zeitraum.</div>`;
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Datum</th>
            <th>Patient</th>
            <th>Geburtsdatum</th>
            <th>Heim</th>
            <th>Typ</th>
            <th>Minuten</th>
            <th>Notiz</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${escapeHtml(formatDate(row.date))}</td>
              <td>${escapeHtml(row.patientName)}</td>
              <td>${escapeHtml(row.birthDate || "—")}</td>
              <td>${escapeHtml(row.homeName)}</td>
              <td>${escapeHtml(row.type)}</td>
              <td>${escapeHtml(String(row.minutes))}</td>
              <td>${escapeHtml(row.note || "—")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderDokuTable(rows) {
  if (!rows.length) return `<div class="empty">Keine Dokumentation im gewählten Zeitraum.</div>`;
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Datum der Behandlung</th>
            <th>Patient</th>
            <th>Geburtsdatum</th>
            <th>Heim</th>
            <th>Doku-Text</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${escapeHtml(formatDate(row.date))}</td>
              <td>${escapeHtml(row.patientName)}</td>
              <td>${escapeHtml(row.birthDate || "—")}</td>
              <td>${escapeHtml(row.homeName)}</td>
              <td>${escapeHtml(row.text || "—")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderKilometerTable(rows) {
  if (!rows.length) return `<div class="empty">Keine Kilometer im gewählten Zeitraum.</div>`;
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Datum</th>
            <th>Von</th>
            <th>Nach</th>
            <th>km</th>
            <th>Vergütung</th>
            <th>Hinweis</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${escapeHtml(formatDate(row.date))}</td>
              <td>${escapeHtml(row.fromLabel)}</td>
              <td>${escapeHtml(row.toLabel)}</td>
              <td>${escapeHtml(String(row.km))}</td>
              <td>${escapeHtml(kilometerEuroText(row.km))}</td>
              <td>${escapeHtml(row.note || (row.manualAdjusted ? "manuell angepasst" : "—"))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function makePrintTable(rows, headers, cellFns) {
  if (!rows.length) return `<p>Keine Einträge im gewählten Zeitraum.</p>`;
  return `
    <table>
      <thead>
        <tr>${headers.map((item) => `<th>${escapeHtml(item)}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>${cellFns.map((fn) => `<td>${escapeHtml(fn(row))}</td>`).join("")}</tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function openPrintWindow(title, subtitle, tableHtml) {
  const printWindow = window.open("", "_blank", "noopener,noreferrer,width=1100,height=800");
  if (!printWindow) {
    alert("Druckfenster konnte nicht geöffnet werden.");
    return;
  }

  printWindow.document.open();
  printWindow.document.write(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:"Segoe UI",Arial,sans-serif;color:#111827;margin:28px;font-size:13px}
  h1{font-size:26px;margin:0 0 8px}
  .sub{color:#475569;margin:0 0 18px;line-height:1.5}
  table{width:100%;border-collapse:collapse}
  th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left;vertical-align:top}
  th{background:#f8fafc}
  @media print{body{margin:12mm}}
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="sub">${escapeHtml(subtitle)}</div>
  ${tableHtml}
</body>
</html>`);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => {
    printWindow.print();
  }, 250);
}

function buildPrintSubtitle(group) {
  const parts = [`Therapeut: ${group.therapistName}`];
  if (state.filters.from || state.filters.to) {
    parts.push(`Zeitraum: ${state.filters.from ? formatDate(state.filters.from) : "offen"} bis ${state.filters.to ? formatDate(state.filters.to) : "offen"}`);
  } else {
    parts.push("Zeitraum: alle geladenen Daten");
  }
  parts.push(`Erstellt: ${formatDateTime(new Date().toISOString())}`);
  return parts.join(" | ");
}

function printCurrentTab() {
  const group = getSelectedGroup();
  if (!group) return;
  const { filteredTime, filteredDocs, filteredKm } = getCurrentFilteredRows(group);
  const title = `FaSt-Viewer – ${getTabLabel(state.selectedTab)}`;
  const subtitle = buildPrintSubtitle(group);

  if (state.selectedTab === "zeit") {
    openPrintWindow(
      title,
      subtitle,
      makePrintTable(filteredTime,
        ["Datum", "Patient", "Geburtsdatum", "Heim", "Typ", "Minuten", "Notiz"],
        [
          (row) => formatDate(row.date),
          (row) => row.patientName,
          (row) => row.birthDate || "—",
          (row) => row.homeName,
          (row) => row.type,
          (row) => String(row.minutes),
          (row) => row.note || "—"
        ]
      )
    );
    return;
  }

  if (state.selectedTab === "doku") {
    openPrintWindow(
      title,
      subtitle,
      makePrintTable(filteredDocs,
        ["Datum der Behandlung", "Patient", "Geburtsdatum", "Heim", "Doku-Text"],
        [
          (row) => formatDate(row.date),
          (row) => row.patientName,
          (row) => row.birthDate || "—",
          (row) => row.homeName,
          (row) => row.text || "—"
        ]
      )
    );
    return;
  }

  openPrintWindow(
    title,
    subtitle,
    makePrintTable(filteredKm,
      ["Datum", "Von", "Nach", "km", "Vergütung", "Hinweis"],
      [
        (row) => formatDate(row.date),
        (row) => row.fromLabel,
        (row) => row.toLabel,
        (row) => String(row.km),
        (row) => kilometerEuroText(row.km),
        (row) => row.note || (row.manualAdjusted ? "manuell angepasst" : "—")
      ]
    )
  );
}

function renderMain() {
  const group = getSelectedGroup();
  if (!group) {
    el.mainContent.innerHTML = `
      <div class="card">
        <h1>Viewer bereit</h1>
        <p>Importiere links ein oder mehrere FaSt-Doku-Backups und wähle danach einen Therapeuten aus.</p>
      </div>
    `;
    return;
  }

  const { filteredTime, filteredDocs, filteredKm, currentRows } = getCurrentFilteredRows(group);

  const summaryStats = {
    timeMinutes: filteredTime.reduce((sum, item) => sum + Number(item.minutes || 0), 0),
    docs: filteredDocs.length,
    km: filteredKm.reduce((sum, item) => sum + Number(item.km || 0), 0),
    days: new Set(currentRows.map((item) => item.date).filter(Boolean)).size
  };

  let contentHtml = "";
  if (state.selectedTab === "zeit") contentHtml = renderZeitTable(filteredTime);
  if (state.selectedTab === "doku") contentHtml = renderDokuTable(filteredDocs);
  if (state.selectedTab === "kilometer") contentHtml = renderKilometerTable(filteredKm);

  el.mainContent.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div>
          <h1>${escapeHtml(group.therapistName)}</h1>
          <div class="pills">
            <span class="pill primary">${group.backups.length} Backup(s)</span>
            ${group.therapistId ? `<span class="pill">ID: ${escapeHtml(group.therapistId)}</span>` : `<span class="pill">Fallback ohne feste ID</span>`}
            <span class="pill">Letzter Export: ${escapeHtml(formatDateTime(group.backups[0]?.exportTimestamp || ""))}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h2>Zeitraum & Bereich</h2>
        </div>
        <div class="actions">
          <button id="printCurrentBtn" class="outline" type="button">Aktuellen Bereich drucken</button>
        </div>
      </div>
      <div class="toolbar">
        <div>
          <label for="filterFrom">Von</label>
          <input id="filterFrom" type="date" value="${escapeHtml(state.filters.from)}">
        </div>
        <div>
          <label for="filterTo">Bis</label>
          <input id="filterTo" type="date" value="${escapeHtml(state.filters.to)}">
        </div>
        <div>
          <label>&nbsp;</label>
          <button id="resetFilterBtn" class="ghost" type="button">Filter zurücksetzen</button>
        </div>
        <div>
          <label>&nbsp;</label>
          <button id="printFilterBtn" class="outline" type="button">Mit Filter drucken</button>
        </div>
      </div>
      <div class="spacer"></div>
      <div class="tabs">
        <button class="tab ${state.selectedTab === "zeit" ? "active" : ""}" data-tab="zeit">Geleistete Zeit</button>
        <button class="tab ${state.selectedTab === "doku" ? "active" : ""}" data-tab="doku">Patienten mit Dokumentation</button>
        <button class="tab ${state.selectedTab === "kilometer" ? "active" : ""}" data-tab="kilometer">Kilometer</button>
      </div>
    </div>

    <div class="card">
      <div class="stats">
        <div class="stat"><div class="muted small">Zeitraum-Stunden</div><strong>${escapeHtml(minutesToHourText(summaryStats.timeMinutes))}</strong></div>
        <div class="stat"><div class="muted small">Doku-Einträge</div><strong>${escapeHtml(String(summaryStats.docs))}</strong></div>
        <div class="stat"><div class="muted small">Kilometer</div><strong>${escapeHtml(String(summaryStats.km))}</strong></div>
        <div class="stat"><div class="muted small">Tage im Bereich</div><strong>${escapeHtml(String(summaryStats.days))}</strong></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div><h2>${getTabLabel(state.selectedTab)}</h2></div>
        <div class="actions">
          <button id="printTableBtn" class="outline" type="button">Diesen Bereich drucken</button>
        </div>
      </div>
      ${contentHtml}
    </div>

    <div class="card">
      <h2>Geladene Backups dieses Therapeuten</h2>
      <div class="list">${renderBackupCards(group.backups)}</div>
    </div>
  `;

  document.getElementById("filterFrom")?.addEventListener("change", (event) => {
    state.filters.from = event.target.value || "";
    renderMain();
  });
  document.getElementById("filterTo")?.addEventListener("change", (event) => {
    state.filters.to = event.target.value || "";
    renderMain();
  });
  document.getElementById("resetFilterBtn")?.addEventListener("click", () => {
    state.filters.from = "";
    state.filters.to = "";
    renderMain();
  });
  document.getElementById("printCurrentBtn")?.addEventListener("click", printCurrentTab);
  document.getElementById("printFilterBtn")?.addEventListener("click", printCurrentTab);
  document.getElementById("printTableBtn")?.addEventListener("click", printCurrentTab);
  el.mainContent.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTab = button.getAttribute("data-tab") || "zeit";
      renderMain();
    });
  });
}

function render() {
  renderTherapistList();
  renderMain();
}

async function handleLoad() {
  const files = Array.from(el.backupFiles.files || []);
  const password = String(el.masterkey.value || "").trim();

  if (!files.length) {
    el.loadMessage.innerHTML = `<div class="error">Bitte mindestens eine ZIP-Datei auswählen.</div>`;
    return;
  }
  if (!password) {
    el.loadMessage.innerHTML = `<div class="error">Bitte Masterkey eingeben.</div>`;
    return;
  }

  el.loadBtn.disabled = true;
  el.loadMessage.textContent = `Lade ${files.length} Datei(en)...`;

  const loaded = [];
  const errors = [];

  for (const file of files) {
    try {
      loaded.push(await parseBackupFile(file, password));
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }

  state.datasets = loaded;
  const groups = getTherapistGroups();
  state.selectedTherapistKey = groups[0]?.therapistKey || "";
  state.selectedTab = "zeit";
  state.filters.from = "";
  state.filters.to = "";

  if (errors.length) {
    el.loadMessage.innerHTML = `<div class="error">${escapeHtml(errors.join(" | "))}</div>`;
  } else {
    el.loadMessage.innerHTML = `<div class="success">${loaded.length} Backup(s) geladen, ${groups.length} Therapeut(en) erkannt.</div>`;
  }

  el.loadBtn.disabled = false;
  render();
}

function clearAll() {
  state.datasets = [];
  state.selectedTherapistKey = "";
  state.selectedTab = "zeit";
  state.filters.from = "";
  state.filters.to = "";
  el.backupFiles.value = "";
  el.masterkey.value = "";
  el.loadMessage.textContent = "Noch keine Backups geladen.";
  render();
}

el.loadBtn.addEventListener("click", handleLoad);
el.clearBtn.addEventListener("click", clearAll);
render();

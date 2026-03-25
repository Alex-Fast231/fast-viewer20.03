import { createEmptyAppData } from "../data/schema.js";
import { setupSecurity, unlockWithPIN, updateSecurityCredentials } from "../security/auth.js";
import { getRemainingLockoutMs } from "../security/lock.js";
import {
  getCryptoMeta,
  getSecurityState,
  setRuntimeSession,
  setCryptoMeta,
  setSecurityState,
  clearRuntimeSession,
  getRuntimeData,
  getRuntimeKey,
  setCurrentView,
  getCurrentView,
  getCurrentContext
} from "../core/app-core.js";
import { loadEncryptedAppData } from "../storage/secure-store.js";
import { logSecurityEvent } from "../security/security-log.js";
import { queuePersistRuntimeData } from "../core/app-core.js";
import {
  createHome,
  createPatient,
  updatePatient,
  updateHomeAddress,
  createRezept,
  updateRezept,
  deleteRezept,
  createRezeptEntry,
  updateRezeptEntry,
  getHomeById,
  getPatientById,
  getRezeptById,
  rezeptSummary,
  searchPatientsInHome,
  buildAbgabeRows,
  filterAbgabeRows,
  buildNachbestellRows,
  filterNachbestellRows,
  getDoctorList,
  saveAbgabeHistory,
  deleteAbgabeHistoryItem,
  saveNachbestellHistorySnapshot,
  deleteNachbestellHistoryItem,
  buildNachbestellLetterData,
  buildAbgabeTree,
  buildNachbestellTree,
  createRezeptTimeEntry,
  deleteRezeptTimeEntry,
  getRezeptTimeEntries,
  getRezeptTimeSummary,
  getPendingKilometerContext,
  saveKilometerStartPoint,
  saveKnownKilometerRoute,
  getKilometerOverview,
  getKilometerPointOptions,
  addManualKilometerTravel,
  updateKilometerTravel,
  deleteKilometerTravel,
  getKilometerPeriodSummary
} from "../modules/homes.js";
import { getRezeptFristInfo } from "../modules/fristen.js";
import { exportBackup, importBackup, downloadBlob, validateBackupZip } from "../modules/backup.js";
import { mutateRuntimeData } from "../core/app-core.js";
import {
  normalizeDeDateInput,
  parseDeDate,
  formatDeDate,
  compareDeDates,
  isDateInRange,
  parseComparableDate,
  listComparableDatesInRange
} from "../core/date-utils.js";

const app = document.getElementById("app");
const lockBtn = document.getElementById("lockBtn");

const collatorDE = new Intl.Collator("de", {
  sensitivity: "base",
  numeric: true
});

function sortHomesAlpha(homes) {
  return [...(homes || [])].sort((a, b) =>
    collatorDE.compare(String(a?.name || ""), String(b?.name || ""))
  );
}

function sortPatientsAlpha(patients) {
  return [...(patients || [])].sort((a, b) => {
    const aName = `${a?.lastName || ""} ${a?.firstName || ""}`.trim();
    const bName = `${b?.lastName || ""} ${b?.firstName || ""}`.trim();
    return collatorDE.compare(aName, bName);
  });
}

function sortRezepteForDisplay(rezepte) {
  return [...(rezepte || [])].sort((a, b) => compareDeDates(b?.ausstell, a?.ausstell));
}

function getStatusPillClass(status) {
  if (status === "Abgegeben") return "pill-gray";
  if (status === "Abgeschlossen") return "pill-blue";
  if (status === "Pausiert") return "pill-orange";
  return "pill-green";
}

function renderRezeptMarkerLine(rezept, frist) {
  const blanko = (rezept.items || []).some((i) => i.type === "Blanko");

  const trafficClass =
    frist.traffic === "red"
      ? "pill-red"
      : frist.traffic === "orange"
        ? "pill-orange"
        : "pill-green";

  return `
    <div style="margin-bottom:8px;">
      <span class="${getStatusPillClass(rezept.status || "Aktiv")}">${escapeHtml(rezept.status || "Aktiv")}</span>
      ${rezept.bg ? `<span class="pill">BG</span>` : ""}
      ${rezept.dt ? `<span class="pill">DT</span>` : ""}
      ${blanko ? `<span class="pill">Blanko</span>` : ""}
      <span class="${trafficClass}">${escapeHtml(frist.statusText || "Frist")}</span>
    </div>
  `;
}

function formatMinutesLabel(minutes) {
  const total = Number(minutes) || 0;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} Min.`;
  if (!m) return `${h} Std.`;
  return `${h} Std. ${m} Min.`;
}

function formatHoursClockLabel(minutes) {
  const total = Math.max(0, Number(minutes) || 0);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${String(m).padStart(2, "0")} Stunden`;
}

function formatComparableToDe(value) {
  return formatDeDate(value);
}

function getWorkDayCodeFromComparable(comparableDate) {
  const date = parseComparableDate(comparableDate);
  if (!date) return '';
  const dayMap = ['SO', 'MO', 'DI', 'MI', 'DO', 'FR', 'SA'];
  return dayMap[date.getDay()] || '';
}

function getDailyPlannedMinutes(settings) {
  const workDays = Array.isArray(settings?.workDays) ? settings.workDays.filter(Boolean) : [];
  const weeklyHoursValue = String(settings?.weeklyHours || '').replace(',', '.').trim();
  const weeklyHours = Number(weeklyHoursValue);
  if (!workDays.length || !Number.isFinite(weeklyHours) || weeklyHours <= 0) return 0;
  return Math.round((weeklyHours * 60) / workDays.length);
}

function getAbsenceRows(data) {
  return Array.isArray(data?.abwesenheiten) ? data.abwesenheiten : [];
}

function getSpecialDayRows(data) {
  return Array.isArray(data?.specialDays) ? data.specialDays : [];
}

function isComparableDateWithinAbsence(comparableDate, absence) {
  const from = parseDeDate(absence?.from);
  const to = parseDeDate(absence?.to);
  if (!from || !to || !comparableDate) return false;
  return comparableDate >= from && comparableDate <= to;
}

function getAbsenceForComparableDate(data, comparableDate) {
  return getAbsenceRows(data).find((item) => isComparableDateWithinAbsence(comparableDate, item)) || null;
}

function getSpecialDayForComparableDate(data, comparableDate) {
  if (!comparableDate) return null;
  const targetDate = formatComparableToDe(comparableDate);
  return getSpecialDayRows(data).find((item) => item?.date === targetDate) || null;
}

function collectAllTimeEntries(data) {
  const rows = [];
  (data?.homes || []).forEach((home) => {
    (home?.patients || []).forEach((patient) => {
      const patientName = `${patient?.lastName || ""}, ${patient?.firstName || ""}`.replace(/^,\s*/, "").trim() || 'Ohne Namen';
      (patient?.rezepte || []).forEach((rezept) => {
        (rezept?.timeEntries || []).forEach((entry) => {
          const minutes = Number(entry?.minutes || 0);
          if (!Number.isFinite(minutes) || minutes <= 0) return;
          rows.push({
            date: String(entry?.date || '').trim(),
            minutes,
            patientName,
            homeName: home?.name || '',
            rezeptLabel: rezeptSummary(rezept),
            type: entry?.type || '',
            note: entry?.note || '',
            createdAt: entry?.createdAt || ''
          });
        });
      });
    });
  });
  return rows;
}

function getTotalTrackedMinutes(data, targetDate = "") {
  const normalizedDate = String(targetDate || '').trim();
  return collectAllTimeEntries(data)
    .filter((entry) => !normalizedDate || entry.date === normalizedDate)
    .reduce((sum, entry) => sum + entry.minutes, 0);
}

function getTimePeriodSummary(data, fromDate, toDate) {
  const rows = collectAllTimeEntries(data)
    .filter((entry) => isDateInRange(entry.date, fromDate, toDate));

  const totalsByDate = new Map();
  rows.forEach((entry) => {
    totalsByDate.set(entry.date, (totalsByDate.get(entry.date) || 0) + entry.minutes);
  });

  const periodDates = listComparableDatesInRange(fromDate, toDate);
  const workDays = Array.isArray(data?.settings?.workDays) ? data.settings.workDays : [];
  const dailyPlannedMinutes = getDailyPlannedMinutes(data?.settings);

  const dailyRows = periodDates.map((comparableDate) => {
    const date = formatComparableToDe(comparableDate);
    const totalMinutes = Number(totalsByDate.get(date) || 0);
    const workDayCode = getWorkDayCodeFromComparable(comparableDate);
    const isWorkDay = workDays.includes(workDayCode);
    const absence = isWorkDay ? getAbsenceForComparableDate(data, comparableDate) : null;
    const specialDay = isWorkDay && !absence ? getSpecialDayForComparableDate(data, comparableDate) : null;
    const plannedMinutes = isWorkDay && !absence && !specialDay ? dailyPlannedMinutes : 0;
    const saldoMinutes = totalMinutes - plannedMinutes;

    return {
      date,
      totalMinutes,
      plannedMinutes,
      saldoMinutes,
      isWorkDay,
      absenceType: absence?.type || '',
      isHoliday: Boolean(specialDay)
    };
  }).filter((row) => row.totalMinutes > 0 || row.plannedMinutes > 0 || row.absenceType || row.isHoliday);

  const totalMinutes = dailyRows.reduce((sum, row) => sum + row.totalMinutes, 0);
  const plannedMinutes = dailyRows.reduce((sum, row) => sum + row.plannedMinutes, 0);
  const saldoMinutes = totalMinutes - plannedMinutes;
  const absenceRows = getAbsenceRows(data).filter((item) => {
    const from = parseDeDate(item?.from);
    const to = parseDeDate(item?.to);
    const filterFrom = parseDeDate(fromDate);
    const filterTo = parseDeDate(toDate);
    if (!from || !to) return false;
    if (filterFrom && to < filterFrom) return false;
    if (filterTo && from > filterTo) return false;
    return true;
  }).sort((a, b) => compareDeDates(a?.from, b?.from));

  const specialDayRows = getSpecialDayRows(data).filter((item) => {
    const date = parseDeDate(item?.date);
    const filterFrom = parseDeDate(fromDate);
    const filterTo = parseDeDate(toDate);
    if (!date) return false;
    if (filterFrom && date < filterFrom) return false;
    if (filterTo && date > filterTo) return false;
    return true;
  }).sort((a, b) => compareDeDates(a?.date, b?.date));

  return {
    fromDate: String(fromDate || '').trim(),
    toDate: String(toDate || '').trim(),
    totalMinutes,
    plannedMinutes,
    saldoMinutes,
    dailyRows,
    absenceRows,
    specialDayRows
  };
}

function getDashboardTodayPatients(data, targetDate = formatCurrentDateShort()) {
  const normalizedDate = String(targetDate || '').trim();
  const rows = [];
  (data?.homes || []).forEach((home) => {
    (home?.patients || []).forEach((patient) => {
      let hasDocumentationForDate = false;
      let totalMinutesForDate = 0;

      (patient?.rezepte || []).forEach((rezept) => {
        (rezept?.entries || []).forEach((entry) => {
          if (String(entry?.date || '').trim() === normalizedDate) {
            hasDocumentationForDate = true;
          }
        });

        (rezept?.timeEntries || []).forEach((entry) => {
          if (String(entry?.date || '').trim() !== normalizedDate) return;
          const minutes = Number(entry?.minutes || 0);
          if (Number.isFinite(minutes)) totalMinutesForDate += minutes;
        });
      });

      if (hasDocumentationForDate) {
        rows.push({
          patientName: `${patient?.lastName || ""}, ${patient?.firstName || ""}`.replace(/^,\s*/, "").trim() || 'Ohne Namen',
          homeName: home?.name || '',
          totalMinutes: totalMinutesForDate
        });
      }
    });
  });
  return rows.sort((a,b)=>collatorDE.compare(a.patientName,b.patientName));
}

function getAllRezeptOptions(data) {
  const rows = [];
  (data?.homes || []).forEach((home) => {
    (home?.patients || []).forEach((patient) => {
      (patient?.rezepte || []).forEach((rezept) => {
        rows.push({
          value: `${home.homeId}__${patient.patientId}__${rezept.rezeptId}`,
          label: `${patient.lastName || ""}, ${patient.firstName || ""}`.replace(/^,\s*/, "").trim() + ` · ${rezeptSummary(rezept)}`,
          homeName: home?.name || ""
        });
      });
    });
  });
  return rows.sort((a, b) => collatorDE.compare(a.label, b.label));
}

function bindCheckChipToggles(root = document) {
  root.querySelectorAll('.check-chip').forEach((chip) => {
    const input = chip.querySelector('input[type="checkbox"]');
    if (!input) return;

    const sync = () => {
      chip.classList.toggle('is-checked', !!input.checked);
    };

    sync();

    if (chip.dataset.bound === '1') return;
    chip.dataset.bound = '1';
    chip.addEventListener('click', (event) => {
      if (event.target === input) return;
      event.preventDefault();
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
    });
    input.addEventListener('change', sync);
  });
}

function bindQuickDocSelectionStyles(root = document) {
  const checks = root.querySelectorAll('.quickDocRezeptCheck');

  const syncGroup = (patientId) => {
    root.querySelectorAll(`.quick-doc-chip[data-patient-id="${patientId}"]`).forEach((chip) => {
      const input = chip.querySelector('.quickDocRezeptCheck');
      chip.classList.toggle('is-checked', !!input?.checked);
    });
  };

  checks.forEach((check) => {
    const patientId = check.dataset.patientId;
    syncGroup(patientId);
    if (check.dataset.bound === '1') return;
    check.dataset.bound = '1';
    check.addEventListener('change', () => syncGroup(patientId));
  });
}

const WORK_DAY_OPTIONS = ["MO", "DI", "MI", "DO", "FR"];

function normalizeWorkDaysForUi(value) {
  const allowed = new Set(WORK_DAY_OPTIONS);
  return Array.isArray(value)
    ? value
        .map((item) => String(item || "").trim().toUpperCase())
        .filter((item, index, array) => allowed.has(item) && array.indexOf(item) === index)
    : [];
}

function normalizeWeeklyHoursInput(value) {
  return String(value || "")
    .trim()
    .replace(",", ".");
}

function isValidWeeklyHours(value) {
  if (!value) return true;
  return /^\d+(?:\.\d+)?$/.test(value);
}

function renderWorkDayChips(selectedDays = [], idPrefix = "workday") {
  const selected = new Set(normalizeWorkDaysForUi(selectedDays));
  return `
    <div class="checkbox-row">
      ${WORK_DAY_OPTIONS.map((day) => `
        <label class="check-chip">
          <input id="${idPrefix}-${day}" class="workday-check" type="checkbox" value="${day}" ${selected.has(day) ? "checked" : ""}>
          <span>${day}</span>
        </label>
      `).join("")}
    </div>
  `;
}

function getSelectedWorkDays(root = document) {
  return WORK_DAY_OPTIONS.filter((day) => {
    const input = root.getElementById ? root.getElementById(`setupWorkDay-${day}`) || root.getElementById(`settingsWorkDay-${day}`) : null;
    return !!input?.checked;
  });
}

function bindSelectableCardChecks(root = document) {
  root.querySelectorAll('.selectable-card').forEach((card) => {
    const input = card.querySelector('input[type="checkbox"]');
    if (!input) return;

    const sync = () => {
      card.classList.toggle('is-selected', !!input.checked);
    };

    sync();

    if (input.dataset.boundCard !== '1') {
      input.dataset.boundCard = '1';
      input.addEventListener('change', sync);
    }

    if (card.dataset.boundSelectableCard === '1') return;
    card.dataset.boundSelectableCard = '1';

    card.addEventListener('click', (event) => {
      if (event.target.closest('input, button, a, select, textarea, summary')) return;
      if (event.target.closest('label')) return;
      event.preventDefault();
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

function getCheckedRowIds(selector, root = document) {
  return Array.from(root.querySelectorAll(`${selector}:checked`))
    .map((element) => String(element.dataset.rowId || '').trim())
    .filter(Boolean);
}

function normalizeSelectedRowIds(selectedIds = [], rows = []) {
  const allowedIds = new Set((rows || []).map((row) => row.rowId));
  return Array.from(new Set((selectedIds || []).filter((id) => allowedIds.has(id))));
}


function getTimeTypeLabel(type) {
  if (type === "besprechung") return "Besprechung";
  if (type === "dokumentation") return "Dokumentation";
  return "Behandlung";
}

function formatKm(value) {
  const km = Number(value || 0);
  return `${km.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} km`;
}

function formatEuro(value) {
  const amount = Number(value || 0);
  return `${amount.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function formatCurrentDateLong(date = new Date()) {
  return date.toLocaleDateString("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

function formatCurrentDateShort(date = new Date()) {
  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

const REZEPT_ITEM_OPTIONS = ["KG", "MT", "KG-ZNS", "MLD30", "MLD45", "MLD60", "Blanko"];

function getKnownDoctorNames(data) {
  return getDoctorList(data).filter(Boolean);
}

function bindDateAutoFormat(input) {
  if (!input || input.dataset.dateAutoBound === '1') return;
  input.dataset.dateAutoBound = '1';
  input.setAttribute("inputmode", "numeric");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("maxlength", "10");
  input.setAttribute("placeholder", input.getAttribute("placeholder") || "TT.MM.JJJJ");
  input.addEventListener("input", () => {
    input.value = normalizeDeDateInput(input.value);
  });
  input.addEventListener("blur", () => {
    input.value = normalizeDeDateInput(input.value);
  });
}

function isAutoDateField(input) {
  if (!input || input.tagName !== "INPUT") return false;
  if ((input.getAttribute("type") || "text").toLowerCase() !== "text") return false;

  const placeholder = String(input.getAttribute("placeholder") || "").trim();
  if (placeholder === "TT.MM.JJJJ") return true;

  const id = String(input.id || "").toLowerCase();
  return [
    "date",
    "birthdate",
    "ausstell",
    "summaryfrom",
    "summaryto",
    "absencefrom",
    "absenceto"
  ].some((token) => id.includes(token));
}

function bindDateAutoFormatsIn(root = document) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  root.querySelectorAll('input').forEach((input) => {
    if (isAutoDateField(input)) bindDateAutoFormat(input);
  });
}

function renderRezeptItemsEditor(items = []) {
  const safe = Array.isArray(items) && items.length ? items : [{}];
  return `
    <div id="leistungenContainer" class="list-stack">
      ${safe.map((item, idx) => renderRezeptItemRow(item, idx)).join("")}
    </div>
    <button id="addLeistungRowBtn" type="button" class="secondary">Leistung hinzufügen</button>
  `;
}

function renderRezeptItemRow(item = {}, idx = 0) {
  const isBlanko = String(item.type || "") === "Blanko";
  return `
    <div class="compact-card rezept-item-row" data-item-row="${idx}" style="padding:14px;">
      <div class="row" style="gap:12px; align-items:end; flex-wrap:wrap;">
        <div style="flex:1; min-width:180px;">
          <label>Leistung</label>
          <select class="rezept-item-type">
            <option value="">Bitte wählen</option>
            ${REZEPT_ITEM_OPTIONS.map(opt => `<option value="${escapeHtml(opt)}" ${String(item.type||'')===opt?'selected':''}>${escapeHtml(opt)}</option>`).join('')}
          </select>
        </div>
        <div style="width:140px; max-width:100%;">
          <label>Anzahl</label>
          <input class="rezept-item-count" type="number" inputmode="numeric" min="0" step="1" value="${escapeHtml(isBlanko ? "" : (item.count || ""))}" placeholder="z.B. 6" ${isBlanko ? "disabled" : ""}>
        </div>
      </div>
    </div>
  `;
}

function updateRezeptItemCountState(row) {
  if (!row) return;
  const typeSelect = row.querySelector(".rezept-item-type");
  const countInput = row.querySelector(".rezept-item-count");
  if (!typeSelect || !countInput) return;
  const isBlanko = typeSelect.value === "Blanko";
  countInput.disabled = isBlanko;
  if (isBlanko) countInput.value = "";
}

function bindRezeptItemsEditor(items = []) {
  const container = document.getElementById("leistungenContainer");
  const bindRow = (row) => {
    if (!row) return;
    const typeSelect = row.querySelector(".rezept-item-type");
    if (typeSelect) {
      typeSelect.addEventListener("change", () => updateRezeptItemCountState(row));
    }
    updateRezeptItemCountState(row);
  };

  if (container) {
    Array.from(container.querySelectorAll(".rezept-item-row")).forEach(bindRow);
  }

  const addBtn = document.getElementById("addLeistungRowBtn");
  if (!addBtn) return;
  addBtn.onclick = () => {
    if (!container) return;
    const idx = container.querySelectorAll("[data-item-row]").length;
    container.insertAdjacentHTML("beforeend", renderRezeptItemRow({}, idx));
    const newRow = container.querySelector(`.rezept-item-row[data-item-row="${idx}"]`);
    bindRow(newRow);
  };
}

function collectRezeptItemsFromForm() {
  return Array.from(document.querySelectorAll(".rezept-item-row")).map((row) => ({
    type: row.querySelector(".rezept-item-type")?.value.trim() || "",
    count: row.querySelector(".rezept-item-count")?.value.trim() || ""
  })).filter((item) => item.type);
}

function render(html) {
  app.innerHTML = html;
  bindDateAutoFormatsIn(app);
}

function openHtmlDocument(title, bodyHtml, { autoPrint = false } = {}) {
  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) {
    alert("Fenster konnte nicht geöffnet werden.");
    return null;
  }

  win.document.write(`
    <!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="UTF-8">
      <title>${escapeHtml(title)}</title>
      <style>
        body{
          font-family: Arial, sans-serif;
          padding: 24px;
          color:#111827;
          line-height: 1.45;
        }
        h1{
          font-size: 22px;
          margin-bottom: 18px;
        }
        .row{
          border-bottom:1px solid #d1d5db;
          padding:10px 0;
        }
        .muted{
          color:#6b7280;
          font-size:12px;
        }
        .print-actions{
          margin-top: 20px;
          display:flex;
          gap:12px;
          flex-wrap:wrap;
        }
        button{
          border:0;
          border-radius:8px;
          padding:10px 14px;
          cursor:pointer;
          background:#2563eb;
          color:white;
          font-weight:600;
        }
        button.secondary{
          background:#e5e7eb;
          color:#111827;
        }
        @media print{
          .print-actions{ display:none; }
          body{ padding:0; }
        }
      </style>
    </head>
    <body>
      ${bodyHtml}
      <div class="print-actions">
        <button onclick="window.print()">Drucken / als PDF speichern</button>
        <button class="secondary" onclick="window.close()">Schließen</button>
      </div>
    </body>
    </html>
  `);

  win.document.close();
  win.focus();
  if (autoPrint) win.print();
  return win;
}

function printHtml(title, bodyHtml) {
  openHtmlDocument(title, `<h1>${escapeHtml(title)}</h1>${bodyHtml}`, { autoPrint: true });
}

function openLetterPreview(title, bodyHtml) {
  openHtmlDocument(title, bodyHtml, { autoPrint: false });
}

function formatIsoDateShort(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return formatCurrentDateShort(new Date());
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function escapeAndPreserveLineBreaks(value) {
  return escapeHtml(String(value || "")).replace(/\n/g, "<br>");
}

function buildCleanLetterHeaderLines(lines = []) {
  const seen = new Set();
  const cleaned = [];

  for (const rawLine of lines) {
    const splitLines = String(rawLine || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of splitLines) {
      const normalized = line.replace(/\s+/g, " ").trim().toLowerCase();
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      cleaned.push(line);
    }
  }

  return cleaned;
}

function flattenNachbestellLines(letterData = {}) {
  return (letterData.groups || []).flatMap((group) =>
    (group.patients || []).flatMap((patient) =>
      (patient.rezepte || []).map((rezept) => ({
        patient: patient.patientName || "",
        geb: patient.geb || "",
        heim: group.type === "hausbesuch" ? "Hausbesuch" : (group.title || ""),
        text: rezept.text || ""
      }))
    )
  );
}

function renderNachbestellLetterHtml(letterData = {}) {
  const createdAt = formatIsoDateShort(letterData.createdAt);
  const praxis = letterData.praxis || {};
  const doctor = letterData.doctor || "";
  const therapistName = praxis.therapistName || "";
  const headerLines = buildCleanLetterHeaderLines([
    praxis.name,
    praxis.department,
    praxis.address,
    praxis.phone ? `Tel.: ${praxis.phone}` : "",
    praxis.fax ? `Fax.: ${praxis.fax}` : ""
  ]);

  return `
    <style>
      .letter-wrap{max-width:820px;margin:0 auto;color:#111827;}
      .letter-head{margin-bottom:28px;}
      .letter-head .line{font-size:14px;}
      .letter-recipient{margin:22px 0 10px;}
      .letter-subject{margin:14px 0 18px;font-weight:700;}
      .letter-date{margin:8px 0 18px;}
      .letter-text{margin-bottom:20px;}
      .letter-group{margin:18px 0 0;}
      .letter-group-title{font-weight:700;}
      .letter-group-address{margin-top:2px;white-space:pre-line;}
      .letter-patient{margin:12px 0 0;}
      .letter-patient-name{font-weight:700;}
      .letter-list{margin:4px 0 0 20px;padding:0;}
      .letter-list li{margin:2px 0;}
      .letter-closing{margin-top:28px;}
    </style>
    <div class="letter-wrap">
      <div class="letter-head">
        ${headerLines.map((line, index) => `<div class="line">${index === 0 ? `<strong>${escapeHtml(line)}</strong>` : escapeHtml(line)}</div>`).join('')}
      </div>

      <div class="letter-recipient">
        <div><strong>An:</strong></div>
        <div>${escapeHtml(doctor || '—')}</div>
      </div>

      <div class="letter-subject">Betreff: Rezeptnachbestellung Physiotherapie</div>
      <div class="letter-date">Datum: ${escapeHtml(createdAt)}</div>

      <div class="letter-text">
        Sehr geehrte Damen und Herren,<br>
        liebes Praxis-Team,<br><br>
        für unsere gemeinsamen Patientinnen und Patienten bitten wir Sie, folgende Heilmittelverordnungen für Physiotherapie auszustellen und diese per Fax an folgende Nummer zu senden:<br>
        Fax: ${escapeHtml(praxis.fax || '—')}<br>
        Bitte senden Sie die Originale der Verordnungen anschließend per Post an die jeweils unten angegebene Einrichtung.<br>
        Vielen Dank für Ihre Unterstützung.
      </div>

      ${(letterData.groups || []).map((group) => `
        <div class="letter-group">
          <div class="letter-group-title">${escapeHtml(group.title || '')}</div>
          ${group.address ? `<div class="letter-group-address">${escapeAndPreserveLineBreaks(group.address)}</div>` : ''}

          ${(group.patients || []).map((patient) => `
            <div class="letter-patient">
              <div class="letter-patient-name">${escapeHtml(patient.patientName || 'Patient')}${patient.geb ? ` – geb. ${escapeHtml(patient.geb)}` : ''}</div>
              <ul class="letter-list">
                ${(patient.rezepte || []).map((rezept) => `<li>${escapeHtml(rezept.text || '—')}</li>`).join('')}
              </ul>
            </div>
          `).join('')}
        </div>
      `).join('')}

      <div class="letter-closing">
        Mit freundlichen Grüßen<br><br>
        ${escapeHtml(therapistName || '')}<br>
        Physiotherapeut<br>
        ${escapeHtml(praxis.name || 'Physio Strobl')} – ${escapeHtml(praxis.department || 'Abteilung FaSt')}
      </div>
    </div>
  `;
}


function ensureDoctorReportsState(rezept) {
  if (!rezept || typeof rezept !== "object") return [];
  if (!Array.isArray(rezept.doctorReports)) {
    rezept.doctorReports = [];
  }
  return rezept.doctorReports;
}

function buildDoctorReportTemplate({ patient, rezept }) {
  const today = formatCurrentDateShort();
  const patientName = `${patient?.firstName || ""} ${patient?.lastName || ""}`.trim() || "Patient/in";
  const birthDate = patient?.birthDate ? `, geb.: ${patient.birthDate}` : "";
  const homeName = patient?.homeName || "";
  const ausstell = rezept?.ausstell || "—";

  return [
    `Therapiebericht an ${rezept?.arzt || "den behandelnden Arzt"} vom ${today}`,
    "",
    "für den Patienten:",
    `${patientName}${birthDate}`,
    homeName ? `Einrichtung: ${homeName}` : "",
    "",
    `Ihre Verordnung vom ${ausstell}`,
    "",
    "Stand der Therapie:",
    "",
    "Besonderheiten während des Behandlungsverlaufs:",
    "",
    "Fortsetzung der Therapie vorgeschlagen:",
    "",
    "Prognostische Einschätzung:",
    "",
    "Mit freundlichen Grüßen",
    "",
    ""
  ].join("\n").replace('für den Patienten:\",\"', 'für den Patienten:');
}

function getPracticeHeaderLines(settings = {}) {
  const lines = buildCleanLetterHeaderLines([
    'Physio Strobl',
    'therapeutisches Handwerk',
    settings.practiceAddress || '',
    settings.practicePhone ? `Telefon ${settings.practicePhone}` : '',
    settings.therapistFax ? `Fax ${settings.therapistFax}` : ''
  ]);
  return lines;
}

function formatDoctorReportBodyHtml(content = "") {
  const labels = [
    'Stand der Therapie:',
    'Besonderheiten während des Behandlungsverlaufs:',
    'Fortsetzung der Therapie vorgeschlagen:',
    'Prognostische Einschätzung:'
  ];

  let html = escapeAndPreserveLineBreaks(content || '').replace(
    /Therapiebericht an .*? vom .*?(<br>|$)/,
    ''
  );

  labels.forEach((label) => {
    const escapedLabel = escapeHtml(label);
    html = html.replaceAll(escapedLabel, `<strong>${escapedLabel}</strong>`);
  });

  return html;
}

function renderDoctorReportPrintHtml({ settings = {}, patient = {}, rezept = {}, report = {} }) {
  const headerLines = getPracticeHeaderLines(settings);
  const createdDate = formatIsoDateShort(report?.createdAt);
  const subjectDate = formatCurrentDateShort(new Date(report?.createdAt || Date.now()));
  const patientName = `${patient?.firstName || ""} ${patient?.lastName || ""}`.trim() || 'Patient/in';
  const bodyHtml = formatDoctorReportBodyHtml(report?.content || '');

  return `
    <style>
      .doctor-report-wrap{max-width:820px;margin:0 auto;color:#111827;}
      .doctor-report-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:28px;}
      .doctor-report-head-left .line{font-size:14px;}
      .doctor-report-date{white-space:nowrap;font-size:14px;}
      .doctor-report-recipient{margin:18px 0 26px;}
      .doctor-report-title{font-size:28px;font-weight:700;margin:0 0 18px;line-height:1.2;}
      .doctor-report-meta{margin:0 0 18px;}
      .doctor-report-body{white-space:normal;line-height:1.55;}
      .doctor-report-sign{margin-top:28px;}
    </style>
    <div class="doctor-report-wrap">
      <div class="doctor-report-head">
        <div class="doctor-report-head-left">
          ${headerLines.map((line, index) => `<div class="line">${index === 0 ? `<strong>${escapeHtml(line)}</strong>` : escapeHtml(line)}</div>`).join('')}
        </div>
        <div class="doctor-report-date">${escapeHtml(createdDate)}</div>
      </div>

      <div class="doctor-report-recipient">${escapeHtml(rezept?.arzt || '—')}</div>
      <div class="doctor-report-title">Therapiebericht an ${escapeHtml(rezept?.arzt || '—')} vom ${escapeHtml(subjectDate)}</div>
      <div class="doctor-report-meta">
        <strong>für den Patienten:</strong><br>
        ${escapeHtml(patientName)}${patient?.birthDate ? `, geb.: ${escapeHtml(patient.birthDate)}` : ''}<br>
        ${patient?.homeName ? `Einrichtung: ${escapeHtml(patient.homeName)}<br>` : ''}
        Ihre Verordnung vom ${escapeHtml(rezept?.ausstell || '—')}
      </div>
      <div class="doctor-report-body">${bodyHtml}</div>
      <div class="doctor-report-sign">${escapeHtml(settings?.therapistName || '')}</div>
    </div>
  `;
}

async function wipeAllAppData() {
  clearRuntimeSession();
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase("fast_doku_db");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error("Datenbank konnte nicht gelöscht werden."));
    req.onblocked = () => reject(new Error("Datenbank-Löschung ist blockiert. Bitte andere Tabs schließen."));
  });
}

export function bindLockButton(onLock) {
  lockBtn.style.display = "inline-block";
  lockBtn.onclick = onLock;
}

export function hideLockButton() {
  lockBtn.style.display = "none";
  lockBtn.onclick = null;
}

function requestPracticePasswordForBackup() {
  return window.prompt("Bitte Praxispasswort eingeben:", "") || "";
}

async function runBackupImportFlow({ file, messageElement, successMessage, beforeReload }) {
  if (!file || !messageElement) return;

  messageElement.className = "muted";
  messageElement.textContent = "Backup wird geprüft...";

  try {
    const practicePassword = requestPracticePasswordForBackup().trim();
    if (!practicePassword) {
      throw new Error("Falsches Praxispasswort");
    }

    const preview = await validateBackupZip(file, practicePassword);
    messageElement.className = "muted";
    messageElement.textContent = `Backup geprüft: ${preview.meta?.therapistName || "FaSt-Doku"} · Export ${preview.meta?.exportTimestamp || ""}`;

    await importBackup(file, practicePassword);
    clearRuntimeSession();

    if (typeof beforeReload === "function") {
      await beforeReload();
    }

    messageElement.className = "success";
    messageElement.textContent = successMessage || "Backup geladen. App wird neu gestartet…";
    setTimeout(() => {
      window.location.reload();
    }, 600);
  } catch (err) {
    console.error(err);
    messageElement.className = "error";
    messageElement.textContent = `Backup-Import fehlgeschlagen: ${err.message || err}`;
  }
}

export function showSetupView({ onSuccess }) {
  hideLockButton();

  render(`
    <div class="card">
      <h2>Ersteinrichtung</h2>
      <p class="muted">FaSt-Doku wird jetzt mit Praxispasswort und Workflow-PIN abgesichert.</p>

      <label for="therapistName">Therapeutenname</label>
      <input id="therapistName" type="text" autocomplete="off">

      <label for="practiceAddress">Praxisadresse</label>
      <textarea id="practiceAddress" rows="3" autocomplete="off">Münchener Str. 155
85051 Ingolstadt</textarea>

      <label for="practicePhone">Telefon</label>
      <input id="practicePhone" type="tel" inputmode="numeric" autocomplete="off">

      <label for="therapistFax">Faxnummer</label>
      <input id="therapistFax" type="tel" inputmode="numeric" autocomplete="off">

      <label>Arbeitstage pro Woche</label>
      ${renderWorkDayChips([], "setupWorkDay")}

      <label for="weeklyHours">Arbeitsstunden pro Woche</label>
      <input id="weeklyHours" type="text" inputmode="decimal" autocomplete="off" placeholder="z. B. 20 oder 38.5">

      <label for="practicePassword">Praxispasswort</label>
      <input id="practicePassword" type="password" autocomplete="new-password">

      <label for="workflowPin">Workflow-PIN (mindestens 6 Zeichen)</label>
      <input id="workflowPin" type="password" inputmode="numeric" autocomplete="new-password">

      <label for="workflowPinRepeat">Workflow-PIN wiederholen</label>
      <input id="workflowPinRepeat" type="password" inputmode="numeric" autocomplete="new-password">

      <button id="saveSetupBtn">Einrichtung abschließen</button>
      <button id="restoreBackupBtn" class="secondary" style="margin-top:10px;">Backup wiederherstellen</button>
      <input id="restoreBackupInput" type="file" accept=".zip" style="display:none;">
      <div id="setupMessage"></div>
    </div>
  `);

  bindCheckChipToggles(app);

  document.getElementById("restoreBackupBtn").onclick = () => {
    document.getElementById("restoreBackupInput").click();
  };

  document.getElementById("restoreBackupInput").onchange = async (event) => {
    const file = event.target.files?.[0];
    const msg = document.getElementById("setupMessage");
    if (!file) return;

    await runBackupImportFlow({
      file,
      messageElement: msg,
      successMessage: "Backup geladen. App wird neu gestartet…"
    });

    event.target.value = "";
  };

  document.getElementById("saveSetupBtn").onclick = async () => {
    const therapistName = document.getElementById("therapistName").value.trim();
    const practiceAddress = document.getElementById("practiceAddress").value.trim();
    const practicePhone = document.getElementById("practicePhone").value.trim();
    const therapistFax = document.getElementById("therapistFax").value.trim();
    const workDays = WORK_DAY_OPTIONS.filter((day) => document.getElementById(`setupWorkDay-${day}`)?.checked);
    const weeklyHours = normalizeWeeklyHoursInput(document.getElementById("weeklyHours").value);
    const password = document.getElementById("practicePassword").value;
    const pin = document.getElementById("workflowPin").value;
    const pinRepeat = document.getElementById("workflowPinRepeat").value;
    const msg = document.getElementById("setupMessage");

    msg.className = "error";
    msg.textContent = "";

    if (!isValidWeeklyHours(weeklyHours)) {
      msg.textContent = "Die Arbeitsstunden pro Woche müssen als Zahl eingegeben werden, z. B. 20 oder 38.5.";
      return;
    }

    if (!password || password.length < 8) {
      msg.textContent = "Das Praxispasswort muss mindestens 8 Zeichen haben.";
      return;
    }

    if (!pin || pin.length < 6) {
      msg.textContent = "Die Workflow-PIN muss mindestens 6 Zeichen haben.";
      return;
    }

    if (pin !== pinRepeat) {
      msg.textContent = "Die Workflow-PIN stimmt nicht überein.";
      return;
    }

    try {
      const initialAppData = createEmptyAppData();
      initialAppData.settings.therapistName = therapistName;
      initialAppData.settings.practiceAddress = practiceAddress;
      initialAppData.settings.practicePhone = practicePhone;
      initialAppData.settings.therapistFax = therapistFax;
      initialAppData.settings.workDays = workDays;
      initialAppData.settings.weeklyHours = weeklyHours;

      const session = await setupSecurity({
        password,
        pin,
        initialAppData
      });

      session.runtimeData = logSecurityEvent(session.runtimeData, "setup", {
        status: "success",
        method: "password+pin",
        message: "Ersteinrichtung erfolgreich abgeschlossen"
      });

      setRuntimeSession(session);
      await queuePersistRuntimeData();
      onSuccess();
    } catch (err) {
      console.error(err);
      msg.textContent = "Einrichtung konnte nicht gespeichert werden.";
    }
  };
}

export function showLoginView({ onSuccess }) {
  hideLockButton();

  const securityState = getSecurityState();
  const remainingMs = getRemainingLockoutMs(securityState);

  render(`
    <div class="card">
      <h2>Workflow-PIN Login</h2>
      <p class="muted">Bitte PIN eingeben, um FaSt-Doku zu entsperren.</p>

      <label for="loginPin">Workflow-PIN</label>
      <input id="loginPin" type="password" inputmode="numeric" autocomplete="current-password">

      <button id="loginBtn">Entsperren</button>

      <div id="loginMessage" class="${remainingMs > 0 ? "error" : ""}">
        ${remainingMs > 0 ? `Sperre aktiv. Noch ${Math.ceil(remainingMs / 1000)} Sekunden.` : ""}
      </div>
    </div>
  `);

  document.getElementById("loginBtn").onclick = async () => {
    const pin = document.getElementById("loginPin").value;
    const msg = document.getElementById("loginMessage");

    msg.className = "error";
    msg.textContent = "";

    try {
      const cryptoMeta = getCryptoMeta();
      const currentSecurityState = getSecurityState();
      const encryptedAppData = await loadEncryptedAppData();

      const session = await unlockWithPIN({
        pin,
        cryptoMeta,
        encryptedAppData,
        securityState: currentSecurityState
      });

      session.runtimeData = logSecurityEvent(session.runtimeData, "unlock", {
        status: "success",
        method: "pin",
        message: "App erfolgreich entsperrt"
      });

      setRuntimeSession({
        ...session,
        cryptoMeta
      });

      await queuePersistRuntimeData();
      onSuccess();
    } catch (err) {
      console.error(err);

      if (err.securityState) {
        setSecurityState(err.securityState);
      }

      if (err.code === "LOCKED_OUT") {
        msg.textContent = "Sperre aktiv. Bitte warten.";
        return;
      }

      if (err.code === "INVALID_PIN") {
        const remaining = getRemainingLockoutMs(err.securityState);
        msg.textContent = remaining > 0
          ? `PIN falsch. Sperre aktiv für ${Math.ceil(remaining / 1000)} Sekunden.`
          : "PIN ist falsch.";
        return;
      }

      msg.textContent = "Login fehlgeschlagen.";
    }
  };
}

function renderDashboardHeaderCard({ therapistName }) {
  return `
    <div class="card">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
        <div>
          <h2 style="margin-bottom:6px;">Dashboard</h2>
          <p class="muted">${escapeHtml(formatCurrentDateLong())}</p>
          <p>Willkommen, ${escapeHtml(therapistName)}.</p>
        </div>
        <button id="openSettingsBtn" class="secondary" title="Einstellungen bearbeiten" aria-label="Einstellungen bearbeiten" style="width:auto; margin-top:0; padding:10px 12px; min-width:48px; font-size:20px; line-height:1;">⚙️</button>
      </div>
    </div>
  `;
}

export function showSettingsView({ onLock }) {
  bindLockButton(onLock);
  setCurrentView("settings");

  const runtimeData = getRuntimeData();
  const settings = runtimeData?.settings || {};

  render(`
    <div class="card">
      <h2>Einstellungen</h2>
      <p class="muted">Hier können die Angaben aus der Ersteinrichtung bearbeitet werden.</p>
      <button id="backDashboardFromSettingsBtn" class="secondary">Zurück zum Dashboard</button>
    </div>

    <div class="card">
      <label for="settingsTherapistName">Therapeutenname</label>
      <input id="settingsTherapistName" type="text" autocomplete="off" value="${escapeHtml(settings.therapistName || "")}">

      <label for="settingsPracticeAddress">Praxisadresse</label>
      <textarea id="settingsPracticeAddress" rows="3" autocomplete="off">${escapeHtml(settings.practiceAddress || "")}</textarea>

      <label for="settingsPracticePhone">Telefon</label>
      <input id="settingsPracticePhone" type="tel" inputmode="numeric" autocomplete="off" value="${escapeHtml(settings.practicePhone || "")}">

      <label for="settingsTherapistFax">Faxnummer</label>
      <input id="settingsTherapistFax" type="tel" inputmode="numeric" autocomplete="off" value="${escapeHtml(settings.therapistFax || "")}">

      <label>Arbeitstage pro Woche</label>
      ${renderWorkDayChips(settings.workDays || [], "settingsWorkDay")}

      <label for="settingsWeeklyHours">Arbeitsstunden pro Woche</label>
      <input id="settingsWeeklyHours" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(settings.weeklyHours || "")}" placeholder="z. B. 20 oder 38.5">

      <div class="muted" style="margin:12px 0 16px 0;">Das Praxispasswort ist als Master-Key fest hinterlegt und kann in der App nicht geändert werden.</div>

      <label for="settingsWorkflowPin">Neue Workflow-PIN</label>
      <input id="settingsWorkflowPin" type="password" inputmode="numeric" autocomplete="new-password" placeholder="leer lassen = unverändert">

      <label for="settingsWorkflowPinRepeat">Neue Workflow-PIN wiederholen</label>
      <input id="settingsWorkflowPinRepeat" type="password" inputmode="numeric" autocomplete="new-password" placeholder="leer lassen = unverändert">

      <button id="saveSettingsBtn">Änderungen speichern</button>
      <div id="settingsMessage"></div>
    </div>
  `);

  bindCheckChipToggles(app);

  document.getElementById("backDashboardFromSettingsBtn").onclick = () => {
    showDashboardView({ onLock });
  };

  document.getElementById("saveSettingsBtn").onclick = async () => {
    const therapistName = document.getElementById("settingsTherapistName").value.trim();
    const practiceAddress = document.getElementById("settingsPracticeAddress").value.trim();
    const practicePhone = document.getElementById("settingsPracticePhone").value.trim();
    const therapistFax = document.getElementById("settingsTherapistFax").value.trim();
    const workDays = WORK_DAY_OPTIONS.filter((day) => document.getElementById(`settingsWorkDay-${day}`)?.checked);
    const weeklyHours = normalizeWeeklyHoursInput(document.getElementById("settingsWeeklyHours").value);
    const newPin = document.getElementById("settingsWorkflowPin").value;
    const newPinRepeat = document.getElementById("settingsWorkflowPinRepeat").value;
    const msg = document.getElementById("settingsMessage");

    msg.className = "error";
    msg.textContent = "";

    if (!isValidWeeklyHours(weeklyHours)) {
      msg.textContent = "Die Arbeitsstunden pro Woche müssen als Zahl eingegeben werden, z. B. 20 oder 38.5.";
      return;
    }

    if ((newPin || newPinRepeat) && newPin !== newPinRepeat) {
      msg.textContent = "Die neue Workflow-PIN stimmt nicht überein.";
      return;
    }

    if (newPin && newPin.length < 6) {
      msg.textContent = "Die Workflow-PIN muss mindestens 6 Zeichen haben.";
      return;
    }

    try {
      mutateRuntimeData((data) => {
        data.settings.therapistName = therapistName;
        data.settings.practiceAddress = practiceAddress;
        data.settings.practicePhone = practicePhone;
        data.settings.therapistFax = therapistFax;
        data.settings.workDays = workDays;
        data.settings.weeklyHours = weeklyHours;
        data.settings.updatedAt = new Date().toISOString();
      });

      if (newPin) {
        const nextCryptoMeta = await updateSecurityCredentials({
          runtimeKey: getRuntimeKey(),
          currentCryptoMeta: getCryptoMeta(),
          pin: newPin
        });
        setCryptoMeta(nextCryptoMeta);
      }

      await queuePersistRuntimeData();
      msg.className = "success";
      msg.textContent = "Einstellungen gespeichert.";
      document.getElementById("settingsWorkflowPin").value = "";
      document.getElementById("settingsWorkflowPinRepeat").value = "";
    } catch (err) {
      console.error(err);
      msg.className = "error";
      msg.textContent = err?.message || "Einstellungen konnten nicht gespeichert werden.";
    }
  };
}

export function showDashboardView({ onLock, timeSummaryFrom = "", timeSummaryTo = "", showTimeOverview = false, showAbsenceForm = "", showHolidayForm = false } = {}) {
  bindLockButton(onLock);
  setCurrentView("dashboard");

  const runtimeData = getRuntimeData();
  const homes = runtimeData?.homes || [];
  const therapistName = runtimeData?.settings?.therapistName || "—";
  const lastBackupAt = runtimeData?.ui?.lastBackupAt || "";
  const todayDate = formatCurrentDateShort();
  const totalTrackedMinutes = getTotalTrackedMinutes(runtimeData, todayDate);
  const timePeriodSummary = getTimePeriodSummary(runtimeData, timeSummaryFrom, timeSummaryTo);
  const hasTimeSummaryFilter = Boolean(String(timeSummaryFrom || '').trim() || String(timeSummaryTo || '').trim());
  const dashboardTodayPatients = getDashboardTodayPatients(runtimeData, todayDate);
  const absenceRows = timePeriodSummary.absenceRows;
  const specialDayRows = timePeriodSummary.specialDayRows;

  render(`
    ${renderDashboardHeaderCard({ therapistName })}

    <details class="accordion" ${showTimeOverview || hasTimeSummaryFilter || showAbsenceForm || showHolidayForm ? 'open' : ''}>
      <summary>
        <span>Überblick</span>
        <span class="muted">Stunden</span>
      </summary>
      <div class="accordion-body">
        <div class="compact-card" style="margin:0;">
          <div style="font-weight:700; margin-bottom:6px;">Stunden heute</div>
          <div class="compact-meta" style="font-size:16px; font-weight:700; color:var(--text);">${escapeHtml(formatHoursClockLabel(totalTrackedMinutes))}</div>
          <div class="compact-meta" style="margin-top:6px;">Aktuelle Zeit · Heute</div>
        </div>
        <div class="row" style="margin-top:10px;">
          <button id="toggleDashboardTimeOverviewBtn" class="secondary">Zeitübersicht</button>
        </div>
        <div id="dashboardTimeOverviewPanel" class="compact-card" style="margin-top:10px; display:${showTimeOverview || hasTimeSummaryFilter ? 'block' : 'none'};">
          <div style="font-weight:700; margin-bottom:10px;">Zeitübersicht</div>
          <label for="dashboardTimeSummaryFrom">Von</label>
          <input id="dashboardTimeSummaryFrom" type="text" value="${escapeHtml(timeSummaryFrom)}" placeholder="TT.MM.JJJJ" inputmode="numeric">

          <label for="dashboardTimeSummaryTo">Bis</label>
          <input id="dashboardTimeSummaryTo" type="text" value="${escapeHtml(timeSummaryTo)}" placeholder="TT.MM.JJJJ" inputmode="numeric">

          <div class="row">
  <button id="openUrlaubBtn" class="secondary">Urlaub</button>
  <button id="openKrankBtn" class="secondary">Krank</button>
</div>

<div class="row">
  <button id="runDashboardTimeSummaryBtn">Auswertung anzeigen</button>
  <button id="openHolidayBtn" class="secondary">Feiertage</button>
</div>

          <div id="dashboardAbsenceFormPanel" class="compact-card" style="margin:12px 0 0 0; padding:10px; display:${showAbsenceForm ? 'block' : 'none'};">
            <div style="font-weight:600; margin-bottom:10px;">${showAbsenceForm === 'krank' ? 'Krank eintragen' : 'Urlaub eintragen'}</div>
            <label for="dashboardAbsenceFrom">Von</label>
            <input id="dashboardAbsenceFrom" type="text" placeholder="TT.MM.JJJJ" inputmode="numeric">

            <label for="dashboardAbsenceTo">Bis</label>
            <input id="dashboardAbsenceTo" type="text" placeholder="TT.MM.JJJJ" inputmode="numeric">

            <div class="row">
              <button id="saveDashboardAbsenceBtn">Speichern</button>
              <button id="cancelDashboardAbsenceBtn" class="secondary">Abbrechen</button>
            </div>
            <div id="dashboardAbsenceMsg"></div>
          </div>

          <div id="dashboardHolidayFormPanel" class="compact-card" style="margin:12px 0 0 0; padding:10px; display:${showHolidayForm ? 'block' : 'none'};">
            <div style="font-weight:600; margin-bottom:10px;">Feiertag eintragen</div>
            <label for="dashboardHolidayDate">Datum</label>
            <input id="dashboardHolidayDate" type="text" placeholder="TT.MM.JJJJ" inputmode="numeric">

            <div class="row">
              <button id="saveDashboardHolidayBtn">Speichern</button>
              <button id="cancelDashboardHolidayBtn" class="secondary">Abbrechen</button>
            </div>
            <div id="dashboardHolidayMsg"></div>
          </div>

          <div class="compact-card" style="margin:12px 0 0 0; padding:10px;">
            <div style="font-weight:600;">Zeitsaldo</div>
            <div class="compact-meta">Geleistete Zeit: ${escapeHtml(formatHoursClockLabel(timePeriodSummary.totalMinutes))}</div>
            <div class="compact-meta">Sollzeit: ${escapeHtml(formatHoursClockLabel(timePeriodSummary.plannedMinutes))}</div>
            <div class="compact-meta">Saldo: ${escapeHtml(formatHoursClockLabel(Math.abs(timePeriodSummary.saldoMinutes)))} ${timePeriodSummary.saldoMinutes > 0 ? 'Plus' : timePeriodSummary.saldoMinutes < 0 ? 'Minus' : 'Ausgeglichen'}</div>
            <div class="compact-meta">Zeitraum: ${escapeHtml(timePeriodSummary.fromDate || '—')} bis ${escapeHtml(timePeriodSummary.toDate || '—')}</div>
          </div>

          <div class="compact-card" style="margin:12px 0 0 0; padding:10px;">
            <div style="font-weight:600; margin-bottom:8px;">Urlaub / Krank / Feiertage</div>
            ${absenceRows.length === 0 && specialDayRows.length === 0 ? `<p class="muted" style="margin:0;">Noch keine Einträge vorhanden.</p>` : `
              ${absenceRows.map((item) => `
                <div class="compact-card" style="margin:0 0 8px 0; padding:10px;">
                  <div style="font-weight:600;">${escapeHtml(item.type === 'krank' ? 'Krank' : 'Urlaub')}</div>
                  <div class="compact-meta">${escapeHtml(item.from || '—')} bis ${escapeHtml(item.to || '—')}</div>
                  <div class="row" style="margin-top:8px;">
                    <button class="secondary delete-absence-btn" data-absence-id="${escapeHtml(item.id)}">Löschen</button>
                  </div>
                </div>
              `).join("")}
              ${specialDayRows.map((item) => `
                <div class="compact-card" style="margin:0 0 8px 0; padding:10px;">
                  <div style="font-weight:600;">Feiertag</div>
                  <div class="compact-meta">${escapeHtml(item.date || '—')}</div>
                  <div class="row" style="margin-top:8px;">
                    <button class="secondary delete-special-day-btn" data-special-day-id="${escapeHtml(item.id)}">Löschen</button>
                  </div>
                </div>
              `).join("")}
            `}
          </div>

          <div style="margin-top:10px;" class="list-stack">
            ${timePeriodSummary.dailyRows.length === 0 ? `<p class="muted">Keine Zeiten im gewählten Zeitraum.</p>` : timePeriodSummary.dailyRows.map((row) => `
              <div class="compact-card" style="margin:0; padding:10px;">
                <div style="font-weight:600;">${escapeHtml(row.date || 'Ohne Datum')}</div>
                <div class="compact-meta">Geleistet: ${escapeHtml(formatHoursClockLabel(row.totalMinutes))}</div>
                <div class="compact-meta">Soll: ${escapeHtml(formatHoursClockLabel(row.plannedMinutes))}</div>
                <div class="compact-meta">Saldo: ${escapeHtml(formatHoursClockLabel(Math.abs(row.saldoMinutes)))} ${row.saldoMinutes > 0 ? 'Plus' : row.saldoMinutes < 0 ? 'Minus' : 'Ausgeglichen'}</div>
                ${row.absenceType ? `<div class="compact-meta">${escapeHtml(row.absenceType === 'krank' ? 'Krank' : 'Urlaub')} · neutral</div>` : row.isHoliday ? `<div class="compact-meta">Feiertag · neutral</div>` : ''}
              </div>
            `).join("")}
          </div>
        </div>
        <details class="accordion" style="margin-top:10px;">
          <summary>
            <span>Patienten</span>
          </summary>
          <div class="accordion-body">
            <div class="list-stack">
              ${dashboardTodayPatients.length === 0 ? `<p class="muted">Heute noch keine Patienten dokumentiert.</p>` : dashboardTodayPatients.map((row) => `
                <div class="compact-card" style="margin:0; padding:10px;">
                  <div style="font-weight:600;">${escapeHtml(row.patientName)}</div>
                  <div class="compact-meta">${escapeHtml(row.homeName || '—')}${row.totalMinutes > 0 ? `<br>${escapeHtml(formatMinutesLabel(row.totalMinutes))}` : ''}</div>
                </div>
              `).join("")}
            </div>
          </div>
        </details>
        <details class="accordion" style="margin-top:10px;">
          <summary>
            <span>Besprechungszeit</span>
            <span class="muted">mit PIN</span>
          </summary>
          <div class="accordion-body">
                <label for="dashboardTimeRezept">Zielrezept</label>
                <select id="dashboardTimeRezept">
                  <option value="">Bitte wählen</option>
                  ${getAllRezeptOptions(runtimeData).map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)} · ${escapeHtml(item.homeName || '—')}</option>`).join("")}
                </select>

                <label for="dashboardTimeDate">Datum</label>
                <input id="dashboardTimeDate" type="text" placeholder="TT.MM.JJJJ" inputmode="numeric">

                <label for="dashboardTimeMinutes">Minuten</label>
                <input id="dashboardTimeMinutes" type="number" min="1" step="1" placeholder="z.B. 60 oder 120" inputmode="numeric">

                <label for="dashboardTimeNote">Notiz</label>
                <input id="dashboardTimeNote" type="text" placeholder="optional">

                <button id="dashboardSaveTimeBtn">Besprechung speichern</button>
                <div id="dashboardTimeMsg"></div>
              </div>
            </details>
          </details>
        </div>
      </div>
    </details>

    <div class="card">
      <h3>Bereiche</h3>
      <div class="row">
        <button id="openHomesBtn">Einrichtungen</button>
        <button id="openAbgabeBtn" class="secondary">Abgabeliste</button>
      </div>
      <div class="row">
        <button id="openNachbestellBtn" class="secondary">Nachbestellung</button>
        <button id="openKilometerBtn" class="secondary">Kilometer</button>
      </div>
      <div class="row">
        <button id="lockNowBtn" class="secondary">Jetzt sperren</button>
      </div>
    </div>

    <details class="accordion">
      <summary>
        <span>Backup</span>
        <span class="muted">Export / Import</span>
      </summary>
      <div class="accordion-body">
        <p class="muted">Lokales ZIP-Backup für Export, Import und spätere Viewer-Kompatibilität.</p>
        <div class="row">
          <button id="exportBackupBtn">Backup exportieren</button>
          <button id="importBackupBtn" class="secondary">Backup importieren</button>
        </div>
        <input id="backupImportInput" type="file" accept=".zip" style="display:none;">
        <div id="backupMsg" class="muted" style="margin-top:12px;">${escapeHtml(lastBackupAt ? `Letztes Backup: ${lastBackupAt}` : "Noch kein Backup exportiert.")}</div>
      </div>
    </details>

    <details class="accordion">
      <summary>
        <span>App zurücksetzen</span>
        <span class="muted">Alle Daten löschen</span>
      </summary>
      <div class="accordion-body">
        <p class="muted">Löscht alle Daten, Passwörter und Einstellungen und startet die App neu.</p>
        <button id="resetAppBtn" class="danger">Alles löschen und neu starten</button>
        <div id="resetMsg"></div>
      </div>
    </details>
  `);

  document.getElementById("openSettingsBtn").onclick = () => showSettingsView({ onLock });
  document.getElementById("openHomesBtn").onclick = () => showHomesView({ onLock });
  document.getElementById("openAbgabeBtn").onclick = () => showAbgabeView({ onLock });
  document.getElementById("openNachbestellBtn").onclick = () => showNachbestellungView({ onLock });
  document.getElementById("openKilometerBtn").onclick = () => showKilometerView({ onLock });
  document.getElementById("lockNowBtn").onclick = onLock;

  const dashboardTimeDate = document.getElementById("dashboardTimeDate");
  if (dashboardTimeDate) {
    bindDateAutoFormat(dashboardTimeDate);
  }

  const dashboardTimeSummaryFrom = document.getElementById("dashboardTimeSummaryFrom");
  const dashboardTimeSummaryTo = document.getElementById("dashboardTimeSummaryTo");
  const dashboardAbsenceFrom = document.getElementById("dashboardAbsenceFrom");
  const dashboardAbsenceTo = document.getElementById("dashboardAbsenceTo");
  const dashboardHolidayDate = document.getElementById("dashboardHolidayDate");
  if (dashboardTimeSummaryFrom) bindDateAutoFormat(dashboardTimeSummaryFrom);
  if (dashboardTimeSummaryTo) bindDateAutoFormat(dashboardTimeSummaryTo);
  if (dashboardAbsenceFrom) bindDateAutoFormat(dashboardAbsenceFrom);
  if (dashboardAbsenceTo) bindDateAutoFormat(dashboardAbsenceTo);
  if (dashboardHolidayDate) bindDateAutoFormat(dashboardHolidayDate);

  const toggleDashboardTimeOverviewBtn = document.getElementById("toggleDashboardTimeOverviewBtn");
  if (toggleDashboardTimeOverviewBtn) {
    toggleDashboardTimeOverviewBtn.onclick = () => {
      const panel = document.getElementById("dashboardTimeOverviewPanel");
      if (!panel) return;
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    };
  }

  const runDashboardTimeSummaryBtn = document.getElementById("runDashboardTimeSummaryBtn");
  if (runDashboardTimeSummaryBtn) {
    runDashboardTimeSummaryBtn.onclick = () => {
      const fromValue = document.getElementById("dashboardTimeSummaryFrom").value.trim();
      const toValue = document.getElementById("dashboardTimeSummaryTo").value.trim();
      showDashboardView({ onLock, timeSummaryFrom: fromValue, timeSummaryTo: toValue, showTimeOverview: true });
    };
  }

  const openUrlaubBtn = document.getElementById("openUrlaubBtn");
  if (openUrlaubBtn) {
    openUrlaubBtn.onclick = () => {
      const fromValue = document.getElementById("dashboardTimeSummaryFrom").value.trim();
      const toValue = document.getElementById("dashboardTimeSummaryTo").value.trim();
      showDashboardView({ onLock, timeSummaryFrom: fromValue, timeSummaryTo: toValue, showTimeOverview: true, showAbsenceForm: "urlaub" });
    };
  }

  const openKrankBtn = document.getElementById("openKrankBtn");
  if (openKrankBtn) {
    openKrankBtn.onclick = () => {
      const fromValue = document.getElementById("dashboardTimeSummaryFrom").value.trim();
      const toValue = document.getElementById("dashboardTimeSummaryTo").value.trim();
      showDashboardView({ onLock, timeSummaryFrom: fromValue, timeSummaryTo: toValue, showTimeOverview: true, showAbsenceForm: "krank" });
    };
  }

  const openHolidayBtn = document.getElementById("openHolidayBtn");
  if (openHolidayBtn) {
    openHolidayBtn.onclick = () => {
      const fromValue = document.getElementById("dashboardTimeSummaryFrom").value.trim();
      const toValue = document.getElementById("dashboardTimeSummaryTo").value.trim();
      showDashboardView({ onLock, timeSummaryFrom: fromValue, timeSummaryTo: toValue, showTimeOverview: true, showHolidayForm: true });
    };
  }

  const cancelDashboardAbsenceBtn = document.getElementById("cancelDashboardAbsenceBtn");
  if (cancelDashboardAbsenceBtn) {
    cancelDashboardAbsenceBtn.onclick = () => {
      const fromValue = document.getElementById("dashboardTimeSummaryFrom").value.trim();
      const toValue = document.getElementById("dashboardTimeSummaryTo").value.trim();
      showDashboardView({ onLock, timeSummaryFrom: fromValue, timeSummaryTo: toValue, showTimeOverview: true, showAbsenceForm: "" });
    };
  }

  const cancelDashboardHolidayBtn = document.getElementById("cancelDashboardHolidayBtn");
  if (cancelDashboardHolidayBtn) {
    cancelDashboardHolidayBtn.onclick = () => {
      const fromValue = document.getElementById("dashboardTimeSummaryFrom").value.trim();
      const toValue = document.getElementById("dashboardTimeSummaryTo").value.trim();
      showDashboardView({ onLock, timeSummaryFrom: fromValue, timeSummaryTo: toValue, showTimeOverview: true, showHolidayForm: false });
    };
  }

  const saveDashboardAbsenceBtn = document.getElementById("saveDashboardAbsenceBtn");
  if (saveDashboardAbsenceBtn) {
    saveDashboardAbsenceBtn.onclick = async () => {
      const msg = document.getElementById("dashboardAbsenceMsg");
      const fromValue = document.getElementById("dashboardAbsenceFrom").value.trim();
      const toValue = document.getElementById("dashboardAbsenceTo").value.trim();
      const normalizedFrom = parseDeDate(fromValue);
      const normalizedTo = parseDeDate(toValue);
      msg.className = "error";
      msg.textContent = "";

      if (!normalizedFrom || !normalizedTo) {
        msg.textContent = "Bitte gültige Von- und Bis-Daten eingeben.";
        return;
      }

      if (normalizedTo < normalizedFrom) {
        msg.textContent = "Bis darf nicht vor Von liegen.";
        return;
      }

      try {
        mutateRuntimeData((data) => {
          if (!Array.isArray(data.abwesenheiten)) data.abwesenheiten = [];
          data.abwesenheiten.push({
            id: `abwesenheit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            type: showAbsenceForm === 'krank' ? 'krank' : 'urlaub',
            from: fromValue,
            to: toValue,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        });
        await queuePersistRuntimeData();
        showDashboardView({ onLock, timeSummaryFrom: document.getElementById("dashboardTimeSummaryFrom").value.trim(), timeSummaryTo: document.getElementById("dashboardTimeSummaryTo").value.trim(), showTimeOverview: true, showAbsenceForm: "" });
      } catch (err) {
        console.error(err);
        msg.textContent = err?.message || "Eintrag konnte nicht gespeichert werden.";
      }
    };
  }


  const saveDashboardHolidayBtn = document.getElementById("saveDashboardHolidayBtn");
  if (saveDashboardHolidayBtn) {
    saveDashboardHolidayBtn.onclick = async () => {
      const msg = document.getElementById("dashboardHolidayMsg");
      const dateValue = document.getElementById("dashboardHolidayDate").value.trim();
      const normalizedDate = parseDeDate(dateValue);
      msg.className = "error";
      msg.textContent = "";

      if (!normalizedDate) {
        msg.textContent = "Bitte ein gültiges Datum eingeben.";
        return;
      }

      try {
        mutateRuntimeData((data) => {
          if (!Array.isArray(data.specialDays)) data.specialDays = [];
          const existingIndex = data.specialDays.findIndex((item) => item?.date === dateValue);
          const nowIso = new Date().toISOString();
          const nextItem = {
            id: existingIndex >= 0 && data.specialDays[existingIndex]?.id
              ? data.specialDays[existingIndex].id
              : `specialday_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            type: "holiday",
            date: dateValue,
            createdAt: existingIndex >= 0 && data.specialDays[existingIndex]?.createdAt
              ? data.specialDays[existingIndex].createdAt
              : nowIso,
            updatedAt: nowIso
          };
          if (existingIndex >= 0) {
            data.specialDays[existingIndex] = nextItem;
          } else {
            data.specialDays.push(nextItem);
          }
        });
        await queuePersistRuntimeData();
        showDashboardView({ onLock, timeSummaryFrom: document.getElementById("dashboardTimeSummaryFrom").value.trim(), timeSummaryTo: document.getElementById("dashboardTimeSummaryTo").value.trim(), showTimeOverview: true, showHolidayForm: false });
      } catch (err) {
        console.error(err);
        msg.textContent = err?.message || "Feiertag konnte nicht gespeichert werden.";
      }
    };
  }

  document.querySelectorAll('.delete-absence-btn').forEach((button) => {
    button.onclick = async () => {
      const absenceId = button.dataset.absenceId || '';
      if (!absenceId) return;
      if (!confirm('Diesen Eintrag wirklich löschen?')) return;
      mutateRuntimeData((data) => {
        data.abwesenheiten = (data.abwesenheiten || []).filter((item) => item.id !== absenceId);
      });
      await queuePersistRuntimeData();
      showDashboardView({ onLock, timeSummaryFrom: document.getElementById("dashboardTimeSummaryFrom").value.trim(), timeSummaryTo: document.getElementById("dashboardTimeSummaryTo").value.trim(), showTimeOverview: true, showAbsenceForm: "" });
    };
  });

  document.querySelectorAll('.delete-special-day-btn').forEach((button) => {
    button.onclick = async () => {
      const specialDayId = button.dataset.specialDayId || '';
      if (!specialDayId) return;
      if (!confirm('Diesen Feiertag wirklich löschen?')) return;
      mutateRuntimeData((data) => {
        data.specialDays = (data.specialDays || []).filter((item) => item.id !== specialDayId);
      });
      await queuePersistRuntimeData();
      showDashboardView({ onLock, timeSummaryFrom: document.getElementById("dashboardTimeSummaryFrom").value.trim(), timeSummaryTo: document.getElementById("dashboardTimeSummaryTo").value.trim(), showTimeOverview: true, showHolidayForm: false });
    };
  });

  const dashboardSaveTimeBtn = document.getElementById("dashboardSaveTimeBtn");
  if (dashboardSaveTimeBtn) {
    dashboardSaveTimeBtn.onclick = async () => {
      const target = document.getElementById("dashboardTimeRezept").value.trim();
      const date = document.getElementById("dashboardTimeDate").value.trim();
      const minutesValue = document.getElementById("dashboardTimeMinutes").value.trim();
      const note = document.getElementById("dashboardTimeNote").value.trim();
      const msg = document.getElementById("dashboardTimeMsg");

      msg.className = "error";
      msg.textContent = "";

      if (!target) {
        msg.textContent = "Bitte zuerst ein Zielrezept auswählen.";
        return;
      }

      const [homeId, patientId, rezeptId] = target.split("__");
      const minutes = Number(minutesValue);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        msg.textContent = "Bitte gültige Minuten für die Besprechung eingeben.";
        return;
      }

      const approvalPin = window.prompt("Bitte PIN vom Abteilungsleiter eingeben:", "");
      if (approvalPin !== "98918072") {
        msg.textContent = "PIN vom Abteilungsleiter ist falsch.";
        return;
      }

      try {
        createRezeptTimeEntry(homeId, patientId, rezeptId, {
          date,
          minutes,
          note,
          confirmed: true
        });
        await queuePersistRuntimeData();
        showDashboardView({ onLock });
      } catch (err) {
        console.error(err);
        msg.textContent = "Besprechungszeit konnte nicht gespeichert werden.";
      }
    };
  }

  document.getElementById("exportBackupBtn").onclick = async () => {
    const msg = document.getElementById("backupMsg");
    msg.className = "muted";
    msg.textContent = "Backup wird erstellt...";

    try {
      const now = new Date().toISOString();
      mutateRuntimeData((data) => {
        data.exportTimestamp = now;
        data.ui.lastBackupAt = now;
        (data.homes || []).forEach((home) => {
          (home.patients || []).forEach((patient) => {
            (patient.rezepte || []).forEach((rezept) => {
              if (!rezept.exportMeta || typeof rezept.exportMeta !== "object") {
                rezept.exportMeta = { exportReady: true, viewerLabel: "", lastExportAt: "" };
              }
              rezept.exportMeta.lastExportAt = now;
            });
          });
        });
      });
      await queuePersistRuntimeData();

      const result = await exportBackup(getRuntimeData());
      downloadBlob(result.blob, result.filename);
      msg.className = "success";
      msg.textContent = `Backup exportiert: ${result.filename}`;
    } catch (err) {
      console.error(err);
      msg.className = "error";
      msg.textContent = `Backup-Export fehlgeschlagen: ${err.message || err}`;
    }
  };

  document.getElementById("importBackupBtn").onclick = () => {
    document.getElementById("backupImportInput").click();
  };

  document.getElementById("backupImportInput").onchange = async (event) => {
    const file = event.target.files?.[0];
    const msg = document.getElementById("backupMsg");
    if (!file) return;

    await runBackupImportFlow({
      file,
      messageElement: msg,
      successMessage: "Backup geladen. App wird neu gestartet…"
    });

    event.target.value = "";
  };

  document.getElementById("resetAppBtn").onclick = async () => {
    const msg = document.getElementById("resetMsg");
    msg.className = "error";
    msg.textContent = "";

    const confirmed = window.confirm("Wirklich alle Daten löschen? Dieser Vorgang kann nicht rückgängig gemacht werden.");
    if (!confirmed) return;

    try {
      await wipeAllAppData();
      window.location.reload();
    } catch (err) {
      console.error(err);
      msg.textContent = err?.message || "Daten konnten nicht gelöscht werden.";
    }
  };
}

export function showHomesView({ onLock, searchText = "" }) {
  bindLockButton(onLock);
  setCurrentView("homes", { searchText });

  const runtimeData = getRuntimeData();
  const homes = sortHomesAlpha(runtimeData?.homes || []);

  render(`
    <div class="card">
      <h2>Einrichtungen</h2>
      <button id="backDashboardBtn" class="secondary">Zurück zum Dashboard</button>
    </div>

    <div class="card">
      <h3>Heimübersicht</h3>

      <div class="list-stack">
        ${homes.length === 0 ? `<p class="muted">Noch keine Einrichtungen vorhanden.</p>` : ""}
        ${homes.map(home => `
          <div class="compact-card home-open-card" data-home-id="${home.homeId}" style="cursor:pointer;">
            <div class="row" style="align-items:center; justify-content:space-between; gap:8px;">
              <div style="flex:1; min-width:0;">
                <div style="font-weight:700;">${escapeHtml(home.name || "Ohne Name")}</div>
                <div class="compact-meta">${escapeHtml(home.adresse || "Keine Adresse")}</div>
                <div class="compact-meta">${home.patients?.length || 0} Patient(en)</div>
              </div>
              <button class="secondary editHomeToggleBtn" data-home-id="${home.homeId}" title="Heim bearbeiten" aria-label="Heim bearbeiten" style="width:auto; padding:8px 10px;">✎</button>
            </div>
            <div class="edit-home-panel" id="edit-home-panel-${home.homeId}" style="display:none; margin-top:12px;">
              <label for="edit-home-name-${home.homeId}">Heimname</label>
              <input id="edit-home-name-${home.homeId}" type="text" value="${escapeHtml(home.name || "")}">

              <label for="edit-home-address-${home.homeId}">Heimadresse</label>
              <input id="edit-home-address-${home.homeId}" type="text" value="${escapeHtml(home.adresse || "")}">

              <div class="row">
                <button class="saveHomeEditBtn" data-home-id="${home.homeId}">Speichern</button>
              </div>
              <div id="home-edit-msg-${home.homeId}"></div>
            </div>
          </div>
        `).join("")}
      </div>

      <details class="accordion" style="margin-top:12px;">
        <summary>
          <span>Neues Heim anlegen</span>
          <span class="muted">Name + Adresse</span>
        </summary>
        <div class="accordion-body">
          <label for="homeName">Name</label>
          <input id="homeName" type="text">

          <label for="homeAddress">Adresse</label>
          <input id="homeAddress" type="text">

          <button id="createHomeBtn">Heim speichern</button>
          <div id="homeMsg"></div>
        </div>
      </details>
    </div>
  `);

  document.getElementById("backDashboardBtn").onclick = () => {
    showDashboardView({ onLock });
  };

  document.getElementById("createHomeBtn").onclick = async () => {
    const name = document.getElementById("homeName").value.trim();
    const adresse = document.getElementById("homeAddress").value.trim();
    const msg = document.getElementById("homeMsg");

    msg.className = "error";
    msg.textContent = "";

    if (!name) {
      msg.textContent = "Bitte einen Heimnamen eingeben.";
      return;
    }

    try {
      createHome({ name, adresse });
      await queuePersistRuntimeData();
      showHomesView({ onLock });
    } catch (err) {
      console.error(err);
      msg.textContent = "Heim konnte nicht gespeichert werden.";
    }
  };

  document.querySelectorAll(".home-open-card").forEach((card) => {
    card.onclick = (event) => {
      if (event.target.closest(".editHomeToggleBtn") || event.target.closest(".saveHomeEditBtn") || event.target.closest(".edit-home-panel")) {
        return;
      }
      showHomeDetailView({ onLock, homeId: card.dataset.homeId });
    };
  });

  document.querySelectorAll(".editHomeToggleBtn").forEach((btn) => {
    btn.onclick = (event) => {
      event.stopPropagation();
      const panel = document.getElementById(`edit-home-panel-${btn.dataset.homeId}`);
      if (panel) {
        panel.style.display = panel.style.display === "none" ? "block" : "none";
      }
    };
  });

  document.querySelectorAll(".saveHomeEditBtn").forEach((btn) => {
    btn.onclick = async (event) => {
      event.stopPropagation();
      const homeId = btn.dataset.homeId;
      const name = document.getElementById(`edit-home-name-${homeId}`).value.trim();
      const adresse = document.getElementById(`edit-home-address-${homeId}`).value.trim();
      const msg = document.getElementById(`home-edit-msg-${homeId}`);

      msg.className = "error";
      msg.textContent = "";

      if (!name) {
        msg.textContent = "Bitte einen Heimnamen eingeben.";
        return;
      }

      try {
        mutateRuntimeData((data) => {
          const home = getHomeById(data, homeId);
          if (!home) throw new Error("Heim nicht gefunden");
          home.name = name;
          home.adresse = adresse;
        });
        await queuePersistRuntimeData();
        showHomesView({ onLock });
      } catch (err) {
        console.error(err);
        msg.textContent = "Heim konnte nicht aktualisiert werden.";
      }
    };
  });
}

export function showHomeDetailView({ onLock, homeId, searchText = "" }) {
  bindLockButton(onLock);
  setCurrentView("home-detail", { homeId, searchText });

  const runtimeData = getRuntimeData();
  const home = getHomeById(runtimeData, homeId);

  if (!home) {
    showHomesView({ onLock });
    return;
  }

  const filteredPatients = sortPatientsAlpha(searchPatientsInHome(home, searchText));

  render(`
    <div class="card">
      <h2>${escapeHtml(home.name || "Einrichtung")}</h2>
      <p class="muted">${escapeHtml(home.adresse || "Keine Adresse")}</p>
      <button id="backHomesBtn" class="secondary">Zurück zu Einrichtungen</button>
    </div>

    <div class="card">
      <h3>Patientenübersicht</h3>

      <details class="accordion">
        <summary>
          <span>Suche und Patient anlegen</span>
          <span class="muted">Suche + neuer Patient</span>
        </summary>
        <div class="accordion-body">
          <label for="patientSearch">Suche nach Name oder Geburtsdatum</label>
          <input id="patientSearch" type="text" value="${escapeHtml(searchText)}" placeholder="z.B. Müller oder 01.01.1950">

          <div class="row">
            <button id="runPatientSearchBtn" class="secondary">Suchen</button>
            <button id="clearPatientSearchBtn" class="secondary">Suche löschen</button>
          </div>

          <label for="lastName">Nachname</label>
          <input id="lastName" type="text">

          <label for="firstName">Vorname</label>
          <input id="firstName" type="text">

          <label for="birthDate">Geburtsdatum</label>
          <input id="birthDate" type="text" placeholder="TT.MM.JJJJ" inputmode="numeric">

          <div class="checkbox-row">
            <label class="check-chip"><input id="befreit" type="checkbox"> <span>Befreit</span></label>
            <label class="check-chip"><input id="hb" type="checkbox"> <span>Hausbesuch</span></label>
            <label class="check-chip"><input id="verstorben" type="checkbox"> <span>Verstorben</span></label>
          </div>

          <button id="createPatientBtn">Patient speichern</button>
          <div id="patientMsg"></div>
        </div>
      </details>

      <div class="list-stack" style="margin-top:12px;">
        ${filteredPatients.length === 0 ? `<p class="muted">Keine passenden Patienten gefunden.</p>` : ""}
        ${filteredPatients.map(patient => {
          const rezepte = sortRezepteForDisplay(patient.rezepte || []);
          return `
            <details class="accordion">
              <summary>
                <span>${escapeHtml(`${patient.lastName || ""}, ${patient.firstName || ""}`.replace(/^,\s*/, "").trim() || "Ohne Namen")}</span>
                <span class="muted">${rezepte.length} Rezept(e)</span>
              </summary>
              <div class="accordion-body">
                <div style="margin-bottom:10px;">
                  ${patient.befreit ? `<span class="pill">Befreit</span>` : ""}
                  ${patient.hb ? `<span class="pill">HB</span>` : ""}
                  ${patient.verstorben ? `<span class="pill-red">Verstorben</span>` : ""}
                </div>

                <div class="inline-action-stack" style="margin-bottom:10px;">
                  <button class="patientSectionBtn secondary" data-target="patient-rezepte-${patient.patientId}">Rezept</button>
                  <button class="patientSectionBtn secondary" data-target="patient-stammdaten-${patient.patientId}">Stammdaten</button>
                </div>
                <div class="inline-action-stack" style="margin-bottom:12px;">
                  <button class="patientSectionBtn secondary" data-target="patient-schnelldoku-${patient.patientId}">SchnellDoku</button>
                  <button class="patientSectionBtn secondary" data-target="patient-arztbericht-${patient.patientId}">Arztbericht</button>
                </div>

                <div id="patient-rezepte-${patient.patientId}" class="patient-inline-section" style="display:none; margin-bottom:12px;">
                  <div class="row" style="margin-bottom:10px;">
                    <button class="createRezeptInlineBtn" data-patient-id="${patient.patientId}">Neues Rezept anlegen</button>
                  </div>

                  ${rezepte.length === 0 ? `<p class="muted">Noch keine Rezepte vorhanden.</p>` : `
                    <div class="list-stack">
                      ${rezepte.map(rezept => {
                        const frist = getRezeptFristInfo(rezept);
                        return `
                          <details class="accordion" style="margin-bottom:8px;">
                            <summary>
                              <span>${escapeHtml(rezeptSummary(rezept))}</span>
                              <span class="muted">${escapeHtml(formatMinutesLabel(getRezeptTimeSummary(rezept).totalMinutes))}</span>
                            </summary>
                            <div class="accordion-body">
                              ${renderRezeptMarkerLine(rezept, frist)}
                              <div class="compact-meta">
                                Arzt: ${escapeHtml(rezept.arzt || "—")}<br>
                                Ausstellung: ${escapeHtml(rezept.ausstell || "—")}<br>
                                Hinweis: ${escapeHtml(frist.detailsText || "—")}<br>
                                Doku-Einträge: ${rezept.entries?.length || 0}<br>
                                Zeit gesamt: ${escapeHtml(formatMinutesLabel(getRezeptTimeSummary(rezept).totalMinutes))}
                              </div>
                              <div class="inline-action-stack" style="margin-top:10px;">
                                <button class="openRezeptBtn" data-patient-id="${patient.patientId}" data-rezept-id="${rezept.rezeptId}">Dokumentieren</button>
                                <button class="editRezeptBtn secondary" data-patient-id="${patient.patientId}" data-rezept-id="${rezept.rezeptId}">Bearbeiten</button>
                              </div>
                            </div>
                          </details>
                        `;
                      }).join("")}
                    </div>
                  `}
                </div>

                <div id="patient-schnelldoku-${patient.patientId}" class="patient-inline-section" style="display:none; margin-bottom:12px;">
                  <div class="compact-meta" style="margin-bottom:10px;">Datum wird automatisch gesetzt: ${escapeHtml(formatCurrentDateShort())}</div>
                  ${rezepte.length === 0 ? `<p class="muted">Keine Rezepte für SchnellDoku vorhanden.</p>` : rezepte.length === 1 ? `
                    <div class="compact-card" style="margin-bottom:10px;">
                      <div style="font-weight:600; margin-bottom:6px;">Zielrezept vom: ${escapeHtml(rezepte[0].ausstell || "—")}</div>
                      <div class="compact-meta">${escapeHtml(rezeptSummary(rezepte[0]))}</div>
                    </div>
                  ` : `
                    <div class="compact-card" style="margin-bottom:10px;">
                      <div style="font-weight:600; margin-bottom:6px;">Zielrezept auswählen</div>
                      <div class="list-stack">
                        ${rezepte.map(rezept => `
                          <label class="check-chip quick-doc-chip" data-patient-id="${patient.patientId}" data-rezept-id="${rezept.rezeptId}" style="flex:1 1 auto;">
                            <input class="quickDocRezeptCheck" type="checkbox" data-patient-id="${patient.patientId}" data-rezept-id="${rezept.rezeptId}">
                            <span>
                              <strong>Zielrezept vom: ${escapeHtml(rezept.ausstell || "—")}</strong><br>
                              <span class="muted">${escapeHtml(rezeptSummary(rezept))}</span>
                            </span>
                          </label>
                        `).join("")}
                      </div>
                    </div>
                  `}

                  <label for="quickDocText-${patient.patientId}">Dokumentation</label>
                  <div class="compact-card" style="margin-bottom:10px; padding:14px;">
                    <textarea id="quickDocText-${patient.patientId}" rows="4" placeholder="Dokumentation direkt zum Rezept speichern" style="width:100%; border:none; outline:none; resize:vertical; background:transparent; font:inherit; color:inherit; min-height:96px;"></textarea>
                  </div>
                  <button class="saveQuickDocBtn" data-patient-id="${patient.patientId}" ${rezepte.length===0?'disabled':''}>SchnellDoku speichern</button>
                  <div id="quickDocMsg-${patient.patientId}"></div>
                </div>

                <div id="patient-arztbericht-${patient.patientId}" class="patient-inline-section" style="display:none; margin-bottom:12px;">
                  ${rezepte.length === 0 ? `<p class="muted">Keine Rezepte für Arztberichte vorhanden.</p>` : `
                    <div class="list-stack">
                      ${rezepte.map(rezept => {
                        const reportCount = ensureDoctorReportsState(rezept).length;
                        const reports = [...ensureDoctorReportsState(rezept)].sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || '')));
                        return `
                          <details class="accordion" style="margin-bottom:8px;">
                            <summary>
                              <span>${escapeHtml(rezeptSummary(rezept))}</span>
                              <span class="muted">${reportCount} Bericht(e)</span>
                            </summary>
                            <div class="accordion-body">
                              <div class="compact-meta" style="margin-bottom:10px;">
                                Arzt: ${escapeHtml(rezept.arzt || '—')}<br>
                                Ausstellung: ${escapeHtml(rezept.ausstell || '—')}<br>
                                Aktuelles Datum wird beim Anlegen automatisch gesetzt.
                              </div>
                              <div class="row" style="margin-bottom:10px;">
                                <button class="createDoctorReportBtn" data-patient-id="${patient.patientId}" data-rezept-id="${rezept.rezeptId}">Neuen Arztbericht erstellen</button>
                              </div>
                              ${reports.length === 0 ? `<p class="muted">Noch keine Arztberichte gespeichert.</p>` : `
                                <div class="list-stack">
                                  ${reports.map(report => `
                                    <div class="compact-card" style="padding:14px;">
                                      <div class="row" style="justify-content:space-between; align-items:center; gap:10px; margin-bottom:8px;">
                                        <div>
                                          <div style="font-weight:700;">${escapeHtml(formatIsoDateShort(report.createdAt))}</div>
                                          <div class="compact-meta">Zuletzt geändert: ${escapeHtml(formatIsoDateShort(report.updatedAt || report.createdAt))}</div>
                                        </div>
                                        <button class="openDoctorReportBtn secondary" data-patient-id="${patient.patientId}" data-rezept-id="${rezept.rezeptId}" data-report-id="${report.reportId}">Öffnen</button>
                                      </div>
                                    </div>
                                  `).join('')}
                                </div>
                              `}
                            </div>
                          </details>
                        `;
                      }).join('')}
                    </div>
                  `}
                </div>

                <div id="patient-stammdaten-${patient.patientId}" class="patient-inline-section" style="display:none;">
                  <label for="edit-lastName-${patient.patientId}">Nachname</label>
                  <input id="edit-lastName-${patient.patientId}" type="text" value="${escapeHtml(patient.lastName || "")}">

                  <label for="edit-firstName-${patient.patientId}">Vorname</label>
                  <input id="edit-firstName-${patient.patientId}" type="text" value="${escapeHtml(patient.firstName || "")}">

                  <label for="edit-birthDate-${patient.patientId}">Geburtsdatum</label>
                  <input id="edit-birthDate-${patient.patientId}" type="text" value="${escapeHtml(patient.birthDate || "")}" inputmode="numeric" placeholder="TT.MM.JJJJ">

                  <div class="checkbox-row">
                    <label class="check-chip"><input id="edit-befreit-${patient.patientId}" type="checkbox" ${patient.befreit ? "checked" : ""}> <span>Befreit</span></label>
                    <label class="check-chip"><input id="edit-hb-${patient.patientId}" type="checkbox" ${patient.hb ? "checked" : ""}> <span>Hausbesuch</span></label>
                    <label class="check-chip"><input id="edit-verstorben-${patient.patientId}" type="checkbox" ${patient.verstorben ? "checked" : ""}> <span>Verstorben</span></label>
                  </div>

                  <button class="savePatientDataBtn" data-patient-id="${patient.patientId}">Stammdaten speichern</button>
                  <div id="patient-edit-msg-${patient.patientId}"></div>
                </div>
              </div>
            </details>
          `;
        }).join("")}
      </div>
    </div>
  `);

  document.getElementById("backHomesBtn").onclick = () => showHomesView({ onLock });

  document.getElementById("runPatientSearchBtn").onclick = () => {
    const value = document.getElementById("patientSearch").value;
    showHomeDetailView({ onLock, homeId, searchText: value });
  };

  document.getElementById("clearPatientSearchBtn").onclick = () => {
    showHomeDetailView({ onLock, homeId, searchText: "" });
  };

  bindDateAutoFormat(document.getElementById("birthDate"));
  document.querySelectorAll('[id^="edit-birthDate-"]').forEach((el) => bindDateAutoFormat(el));
  bindCheckChipToggles(app);
  bindQuickDocSelectionStyles(app);
  bindSelectableCardChecks(app);

  document.getElementById("createPatientBtn").onclick = async () => {
    const firstName = document.getElementById("firstName").value.trim();
    const lastName = document.getElementById("lastName").value.trim();
    const birthDate = document.getElementById("birthDate").value.trim();
    const befreit = document.getElementById("befreit").checked;
    const hb = document.getElementById("hb").checked;
    const verstorben = document.getElementById("verstorben").checked;
    const msg = document.getElementById("patientMsg");

    msg.className = "error";
    msg.textContent = "";

    if (!firstName && !lastName) {
      msg.textContent = "Bitte mindestens einen Namen eingeben.";
      return;
    }

    try {
      createPatient(homeId, {
        firstName,
        lastName,
        birthDate,
        befreit,
        hb,
        verstorben
      });
      await queuePersistRuntimeData();
      showHomeDetailView({ onLock, homeId, searchText });
    } catch (err) {
      console.error(err);
      msg.textContent = "Patient konnte nicht gespeichert werden.";
    }
  };

  document.querySelectorAll('.patientSectionBtn').forEach((btn) => {
    btn.onclick = () => {
      const body = btn.closest('.accordion-body');
      body.querySelectorAll('.patient-inline-section').forEach((section) => {
        section.style.display = 'none';
      });
      const target = document.getElementById(btn.dataset.target);
      if (target) target.style.display = 'block';
    };
  });

  document.querySelectorAll('.createRezeptInlineBtn').forEach((btn) => {
    btn.onclick = () => {
      showCreateRezeptView({ onLock, homeId, patientId: btn.dataset.patientId });
    };
  });

  document.querySelectorAll('.openRezeptBtn').forEach((btn) => {
    btn.onclick = () => {
      showRezeptDetailView({
        onLock,
        homeId,
        patientId: btn.dataset.patientId,
        rezeptId: btn.dataset.rezeptId
      });
    };
  });

  document.querySelectorAll('.editRezeptBtn').forEach((btn) => {
    btn.onclick = () => {
      showEditRezeptView({
        onLock,
        homeId,
        patientId: btn.dataset.patientId,
        rezeptId: btn.dataset.rezeptId
      });
    };
  });

  document.querySelectorAll('.quickDocRezeptCheck').forEach((check) => {
    check.addEventListener('change', () => {
      if (!check.checked) return;
      const patientId = check.dataset.patientId;
      document.querySelectorAll(`.quickDocRezeptCheck[data-patient-id="${patientId}"]`).forEach((other) => {
        if (other !== check) other.checked = false;
      });
    });
  });

  document.querySelectorAll('.saveQuickDocBtn').forEach((btn) => {
    btn.onclick = async () => {
      const patientId = btn.dataset.patientId;
      const patient = getPatientById(home, patientId);
      const rezepte = sortRezepteForDisplay(patient?.rezepte || []);
      const msg = document.getElementById(`quickDocMsg-${patientId}`);
      const text = document.getElementById(`quickDocText-${patientId}`).value.trim();

      msg.className = 'error';
      msg.textContent = '';

      if (!text) {
        msg.textContent = 'Bitte einen Dokumentationstext eingeben.';
        return;
      }

      let targetRezeptId = '';
      if (rezepte.length === 1) {
        targetRezeptId = rezepte[0].rezeptId;
      } else {
        const checked = document.querySelector(`.quickDocRezeptCheck[data-patient-id="${patientId}"]:checked`);
        if (!checked) {
          msg.textContent = 'Bitte genau ein Rezept auswählen.';
          return;
        }
        targetRezeptId = checked.dataset.rezeptId;
      }

      try {
        const quickDate = formatCurrentDateShort();
        const pendingKm = getPendingKilometerContext(homeId, patientId, quickDate);
        if (pendingKm.needsKmInput) {
          const entered = window.prompt(`Bitte Entfernung eingeben:
${pendingKm.fromLabel} → ${pendingKm.toLabel}`, "");
          if (entered === null) {
            msg.textContent = 'SchnellDoku abgebrochen, da die Kilometer nicht eingegeben wurden.';
            return;
          }
          const kmValue = Number(String(entered).replace(',', '.'));
          if (!Number.isFinite(kmValue) || kmValue <= 0) {
            msg.textContent = 'Bitte gültige Kilometer für die neue Strecke eingeben.';
            return;
          }
          saveKnownKilometerRoute({
            fromPointId: pendingKm.fromPointId,
            toPointId: pendingKm.toPointId,
            fromLabel: pendingKm.fromLabel,
            toLabel: pendingKm.toLabel,
            km: kmValue
          });
        }

        createRezeptEntry(homeId, patientId, targetRezeptId, {
          date: quickDate,
          text
        });
        await queuePersistRuntimeData();
        showHomeDetailView({ onLock, homeId, searchText });
      } catch (err) {
        console.error(err);
        msg.textContent = 'SchnellDoku konnte nicht gespeichert werden.';
      }
    };
  });

  document.querySelectorAll('.createDoctorReportBtn').forEach((btn) => {
    btn.onclick = async () => {
      try {
        let createdReportId = '';
        mutateRuntimeData((data) => {
          const currentHome = getHomeById(data, homeId);
          const currentPatient = getPatientById(currentHome, btn.dataset.patientId);
          const rezept = getRezeptById(currentPatient, btn.dataset.rezeptId);
          if (!currentPatient || !rezept) throw new Error('Rezept nicht gefunden');
          const reports = ensureDoctorReportsState(rezept);
          const now = new Date().toISOString();
          createdReportId = `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          reports.unshift({
            reportId: createdReportId,
            content: buildDoctorReportTemplate({
              patient: { ...currentPatient, homeName: currentHome?.name || '' },
              rezept
            }),
            createdAt: now,
            updatedAt: now
          });
        });
        await queuePersistRuntimeData();
        showDoctorReportEditorView({
          onLock,
          homeId,
          patientId: btn.dataset.patientId,
          rezeptId: btn.dataset.rezeptId,
          reportId: createdReportId,
          searchText
        });
      } catch (err) {
        console.error(err);
        alert(err?.message || 'Arztbericht konnte nicht erstellt werden.');
      }
    };
  });

  document.querySelectorAll('.openDoctorReportBtn').forEach((btn) => {
    btn.onclick = () => {
      showDoctorReportEditorView({
        onLock,
        homeId,
        patientId: btn.dataset.patientId,
        rezeptId: btn.dataset.rezeptId,
        reportId: btn.dataset.reportId,
        searchText
      });
    };
  });

  document.querySelectorAll('.savePatientDataBtn').forEach((btn) => {
    btn.onclick = async () => {
      const patientId = btn.dataset.patientId;
      const msg = document.getElementById(`patient-edit-msg-${patientId}`);
      msg.className = 'error';
      msg.textContent = '';

      try {
        updatePatient(homeId, patientId, {
          firstName: document.getElementById(`edit-firstName-${patientId}`).value.trim(),
          lastName: document.getElementById(`edit-lastName-${patientId}`).value.trim(),
          birthDate: document.getElementById(`edit-birthDate-${patientId}`).value.trim(),
          befreit: document.getElementById(`edit-befreit-${patientId}`).checked,
          hb: document.getElementById(`edit-hb-${patientId}`).checked,
          verstorben: document.getElementById(`edit-verstorben-${patientId}`).checked
        });
        await queuePersistRuntimeData();
        showHomeDetailView({ onLock, homeId, searchText });
      } catch (err) {
        console.error(err);
        msg.textContent = 'Stammdaten konnten nicht gespeichert werden.';
      }
    };
  });
}


export function showDoctorReportEditorView({ onLock, homeId, patientId, rezeptId, reportId, searchText = "" }) {
  bindLockButton(onLock);
  setCurrentView("doctor-report-editor", { homeId, patientId, rezeptId, reportId, searchText });

  const runtimeData = getRuntimeData();
  const home = getHomeById(runtimeData, homeId);
  const patient = getPatientById(home, patientId);
  const rezept = getRezeptById(patient, rezeptId);
  const report = ensureDoctorReportsState(rezept).find((item) => item.reportId === reportId);

  if (!home || !patient || !rezept || !report) {
    showHomeDetailView({ onLock, homeId, searchText });
    return;
  }

  const patientName = `${patient.firstName || ''} ${patient.lastName || ''}`.trim() || 'Patient/in';

  render(`
    <div class="card">
      <h2>Arztbericht</h2>
      <p class="muted">Patient: ${escapeHtml(patientName)} · Rezept: ${escapeHtml(rezeptSummary(rezept))}</p>
      <button id="backDoctorReportBtn" class="secondary">Zurück zur Patientenübersicht</button>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:12px;">
        <div>
          <div><strong>Erstellt:</strong> ${escapeHtml(formatIsoDateShort(report.createdAt))}</div>
          <div class="muted">Zuletzt geändert: ${escapeHtml(formatIsoDateShort(report.updatedAt || report.createdAt))}</div>
        </div>
        <div class="muted" style="text-align:right;">Arzt: ${escapeHtml(rezept.arzt || '—')}<br>Verordnung vom ${escapeHtml(rezept.ausstell || '—')}</div>
      </div>

      <label for="doctorReportEditorText">Arztbericht</label>
      <div class="compact-card" style="margin-bottom:14px; padding:16px;">
        <textarea id="doctorReportEditorText" rows="22" style="width:100%; border:none; outline:none; resize:vertical; background:transparent; font:inherit; color:inherit; min-height:560px; line-height:1.5;">${escapeHtml(report.content || '')}</textarea>
      </div>

      <div class="row" style="margin-bottom:8px; flex-wrap:wrap;">
        <button id="saveDoctorReportEditorBtn">Speichern</button>
        <button id="printDoctorReportEditorBtn" class="secondary">Drucken</button>
        <button id="deleteDoctorReportEditorBtn" class="secondary">Löschen</button>
      </div>
      <div id="doctorReportEditorMsg"></div>
    </div>
  `);

  document.getElementById('backDoctorReportBtn').onclick = () => {
    showHomeDetailView({ onLock, homeId, searchText });
  };

  document.getElementById('saveDoctorReportEditorBtn').onclick = async () => {
    const msg = document.getElementById('doctorReportEditorMsg');
    msg.className = 'error';
    msg.textContent = '';

    try {
      const content = document.getElementById('doctorReportEditorText').value.trim();
      if (!content) {
        msg.textContent = 'Bitte einen Berichtstext eingeben.';
        return;
      }

      mutateRuntimeData((data) => {
        const currentHome = getHomeById(data, homeId);
        const currentPatient = getPatientById(currentHome, patientId);
        const currentRezept = getRezeptById(currentPatient, rezeptId);
        const currentReport = ensureDoctorReportsState(currentRezept).find((item) => item.reportId === reportId);
        if (!currentReport) throw new Error('Bericht nicht gefunden');
        currentReport.content = content;
        currentReport.updatedAt = new Date().toISOString();
      });
      await queuePersistRuntimeData();
      msg.className = 'success';
      msg.textContent = 'Arztbericht gespeichert.';
      showDoctorReportEditorView({ onLock, homeId, patientId, rezeptId, reportId, searchText });
    } catch (err) {
      console.error(err);
      msg.textContent = 'Arztbericht konnte nicht gespeichert werden.';
    }
  };

  document.getElementById('printDoctorReportEditorBtn').onclick = () => {
    try {
      const currentHome = getHomeById(getRuntimeData(), homeId);
      const currentPatient = getPatientById(currentHome, patientId);
      const currentRezept = getRezeptById(currentPatient, rezeptId);
      const currentReport = ensureDoctorReportsState(currentRezept).find((item) => item.reportId === reportId);
      if (!currentHome || !currentPatient || !currentRezept || !currentReport) throw new Error('Bericht nicht gefunden');
      const previewReport = {
        ...currentReport,
        content: document.getElementById('doctorReportEditorText').value.trim() || currentReport.content || ''
      };
      openLetterPreview(
        `Arztbericht ${currentPatient.lastName || ''}`.trim(),
        renderDoctorReportPrintHtml({
          settings: getRuntimeData()?.settings || {},
          patient: { ...currentPatient, homeName: currentHome?.name || '' },
          rezept: currentRezept,
          report: previewReport
        })
      );
    } catch (err) {
      console.error(err);
      alert(err?.message || 'Arztbericht konnte nicht gedruckt werden.');
    }
  };

  document.getElementById('deleteDoctorReportEditorBtn').onclick = async () => {
    if (!confirm('Diesen Arztbericht wirklich löschen?')) return;
    try {
      mutateRuntimeData((data) => {
        const currentHome = getHomeById(data, homeId);
        const currentPatient = getPatientById(currentHome, patientId);
        const currentRezept = getRezeptById(currentPatient, rezeptId);
        const reports = ensureDoctorReportsState(currentRezept);
        currentRezept.doctorReports = reports.filter((item) => item.reportId !== reportId);
      });
      await queuePersistRuntimeData();
      showHomeDetailView({ onLock, homeId, searchText });
    } catch (err) {
      console.error(err);
      alert(err?.message || 'Arztbericht konnte nicht gelöscht werden.');
    }
  };
}

export function showPatientDetailView({ onLock, homeId, patientId }) {
  bindLockButton(onLock);
  setCurrentView("patient-detail", { homeId, patientId });

  const runtimeData = getRuntimeData();
  const home = getHomeById(runtimeData, homeId);
  const patient = getPatientById(home, patientId);

  if (!home || !patient) {
    showHomeDetailView({ onLock, homeId });
    return;
  }

  const rezepte = sortRezepteForDisplay(patient.rezepte || []);

  render(`
    <div class="card">
      <h2>${escapeHtml(`${patient.firstName} ${patient.lastName}`.trim() || "Patient")}</h2>
      <p class="muted">Heim: ${escapeHtml(home.name || "—")}</p>
      <button id="backHomeDetailBtn" class="secondary">Zurück zum Heim</button>
    </div>

    <div class="card">
      <h3>Rezepte</h3>
      <button id="openCreateRezeptBtn">Neues Rezept anlegen</button>

      <div class="list-stack" style="margin-top:14px;">
        ${rezepte.length === 0 ? `<p class="muted">Noch keine Rezepte vorhanden.</p>` : ""}
        ${rezepte.map(rezept => {
          const frist = getRezeptFristInfo(rezept);
          return `
            <details class="accordion">
              <summary>
                <span>${escapeHtml(rezeptSummary(rezept))}</span>
                <span class="muted">${escapeHtml(formatMinutesLabel(getRezeptTimeSummary(rezept).totalMinutes))}</span>
              </summary>
              <div class="accordion-body">
                ${renderRezeptMarkerLine(rezept, frist)}
                <div class="compact-meta">
                  Arzt: ${escapeHtml(rezept.arzt || "—")}<br>
                  Ausstellung: ${escapeHtml(rezept.ausstell || "—")}<br>
                  Hinweis: ${escapeHtml(frist.detailsText || "—")}<br>
                  Doku-Einträge: ${rezept.entries?.length || 0}<br>
                  Zeit gesamt: ${escapeHtml(formatMinutesLabel(getRezeptTimeSummary(rezept).totalMinutes))}
                </div>
                <div class="row" style="margin-top:10px;">
                  <button class="openRezeptBtn" data-rezept-id="${rezept.rezeptId}">Rezept öffnen</button>
                  <button class="editRezeptBtn secondary" data-rezept-id="${rezept.rezeptId}">Bearbeiten</button>
                </div>
              </div>
            </details>
          `;
        }).join("")}
      </div>
    </div>

    <details class="accordion">
      <summary>
        <span>Stammdaten</span>
        <span class="muted">anzeigen</span>
      </summary>
      <div class="accordion-body">
        <p><strong>Vorname:</strong> ${escapeHtml(patient.firstName || "—")}</p>
        <p><strong>Nachname:</strong> ${escapeHtml(patient.lastName || "—")}</p>
        <p><strong>Geburtsdatum:</strong> ${escapeHtml(patient.birthDate || "—")}</p>
        <p><strong>Befreit:</strong> ${patient.befreit ? "Ja" : "Nein"}</p>
        <p><strong>Hausbesuch:</strong> ${patient.hb ? "Ja" : "Nein"}</p>
        <p><strong>Verstorben:</strong> ${patient.verstorben ? "Ja" : "Nein"}</p>
      </div>
    </details>
  `);

  document.getElementById("backHomeDetailBtn").onclick = () => {
    showHomeDetailView({ onLock, homeId });
  };

  document.getElementById("openCreateRezeptBtn").onclick = () => {
    showCreateRezeptView({ onLock, homeId, patientId });
  };

  document.querySelectorAll(".openRezeptBtn").forEach((btn) => {
    btn.onclick = () => {
      showRezeptDetailView({
        onLock,
        homeId,
        patientId,
        rezeptId: btn.dataset.rezeptId
      });
    };
  });

  document.querySelectorAll(".editRezeptBtn").forEach((btn) => {
    btn.onclick = () => {
      showEditRezeptView({
        onLock,
        homeId,
        patientId,
        rezeptId: btn.dataset.rezeptId
      });
    };
  });
}

export function showCreateRezeptView({ onLock, homeId, patientId }) {
  bindLockButton(onLock);
  setCurrentView("rezept-create", { homeId, patientId });

  render(`
    <div class="card">
      <h2>Neues Rezept</h2>
      <button id="backPatientBtn" class="secondary">Zurück zum Patienten</button>
    </div>

    <div class="card">
      <label for="arzt">Arzt</label>
      <input id="arzt" type="text" list="doctorSuggestions" autocomplete="off">
      <datalist id="doctorSuggestions">
        ${getKnownDoctorNames(getRuntimeData()).map((name) => `<option value="${escapeHtml(name)}"></option>`).join("")}
      </datalist>

      <label for="ausstell">Ausstellungsdatum</label>
      <input id="ausstell" type="text" placeholder="TT.MM.JJJJ" inputmode="numeric">

      <div class="checkbox-row">
        <label class="check-chip"><input id="bg" type="checkbox"> <span>BG</span></label>
        <label class="check-chip"><input id="dt" type="checkbox"> <span>Doppeltermin</span></label>
      </div>

      <h3 style="margin-top:20px;">Leistungen</h3>
      ${renderRezeptItemsEditor([])}

      <button id="saveRezeptBtn">Rezept speichern</button>
      <div id="rezeptMsg"></div>
    </div>
  `);

  document.getElementById("backPatientBtn").onclick = () => {
    showPatientDetailView({ onLock, homeId, patientId });
  };

  bindDateAutoFormat(document.getElementById("ausstell"));
  bindRezeptItemsEditor([]);
  bindCheckChipToggles(app);
  bindQuickDocSelectionStyles(app);
  bindSelectableCardChecks(app);

  document.getElementById("saveRezeptBtn").onclick = async () => {
    const msg = document.getElementById("rezeptMsg");
    msg.className = "error";
    msg.textContent = "";

    const items = collectRezeptItemsFromForm();

    if (items.length === 0) {
      msg.textContent = "Bitte mindestens eine Leistung angeben.";
      return;
    }

    try {
      createRezept(homeId, patientId, {
        arzt: document.getElementById("arzt").value.trim(),
        ausstell: document.getElementById("ausstell").value.trim(),
        bg: document.getElementById("bg").checked,
        dt: document.getElementById("dt").checked,
        items
      });

      await queuePersistRuntimeData();
      showPatientDetailView({ onLock, homeId, patientId });
    } catch (err) {
      console.error(err);
      msg.textContent = "Rezept konnte nicht gespeichert werden.";
    }
  };
}

export function showEditRezeptView({ onLock, homeId, patientId, rezeptId }) {
  bindLockButton(onLock);
  setCurrentView("rezept-edit", { homeId, patientId, rezeptId });

  const runtimeData = getRuntimeData();
  const home = getHomeById(runtimeData, homeId);
  const patient = getPatientById(home, patientId);
  const rezept = getRezeptById(patient, rezeptId);

  if (!home || !patient || !rezept) {
    showPatientDetailView({ onLock, homeId, patientId });
    return;
  }

  const items = rezept.items || [];

  render(`
    <div class="card">
      <h2>Rezept bearbeiten</h2>
      <button id="backPatientBtn" class="secondary">Zurück zum Patienten</button>
    </div>

    <div class="card">
      <label for="arzt">Arzt</label>
      <input id="arzt" type="text" list="doctorSuggestions" autocomplete="off" value="${escapeHtml(rezept.arzt || "")}">
      <datalist id="doctorSuggestions">
        ${getKnownDoctorNames(getRuntimeData()).map((name) => `<option value="${escapeHtml(name)}"></option>`).join("")}
      </datalist>

      <label for="ausstell">Ausstellungsdatum</label>
      <input id="ausstell" type="text" inputmode="numeric" value="${escapeHtml(rezept.ausstell || "")}">

      <div class="checkbox-row">
        <label class="check-chip"><input id="bg" type="checkbox" ${rezept.bg ? "checked" : ""}> <span>BG</span></label>
        <label class="check-chip"><input id="dt" type="checkbox" ${rezept.dt ? "checked" : ""}> <span>Doppeltermin</span></label>
      </div>

      <h3 style="margin-top:20px;">Leistungen</h3>
      ${renderRezeptItemsEditor(items)}

      <button id="updateRezeptBtn">Änderungen speichern</button>
      <button id="deleteRezeptBtn" class="danger">Rezept löschen</button>
      <div id="rezeptMsg"></div>
    </div>
  `);

  document.getElementById("backPatientBtn").onclick = () => {
    showPatientDetailView({ onLock, homeId, patientId });
  };

  bindDateAutoFormat(document.getElementById("ausstell"));
  bindRezeptItemsEditor(items);
  bindCheckChipToggles(app);
  bindQuickDocSelectionStyles(app);
  bindSelectableCardChecks(app);

  document.getElementById("updateRezeptBtn").onclick = async () => {
    const msg = document.getElementById("rezeptMsg");
    msg.className = "error";
    msg.textContent = "";

    const nextItems = collectRezeptItemsFromForm().map((item, idx) => ({
      itemId: rezept.items?.[idx]?.itemId,
      ...item
    }));

    if (nextItems.length === 0) {
      msg.textContent = "Bitte mindestens eine Leistung angeben.";
      return;
    }

    try {
      updateRezept(homeId, patientId, rezeptId, {
        arzt: document.getElementById("arzt").value.trim(),
        ausstell: document.getElementById("ausstell").value.trim(),
        bg: document.getElementById("bg").checked,
        dt: document.getElementById("dt").checked,
        items: nextItems
      });

      await queuePersistRuntimeData();
      showPatientDetailView({ onLock, homeId, patientId });
    } catch (err) {
      console.error(err);
      msg.textContent = "Rezept konnte nicht aktualisiert werden.";
    }
  };

  document.getElementById("deleteRezeptBtn").onclick = async () => {
    const ok = window.confirm(
      "Rezept wirklich löschen?\n\nDokumentationseinträge und Zeiteinträge werden ebenfalls mit gelöscht."
    );
    if (!ok) return;

    try {
      deleteRezept(homeId, patientId, rezeptId);
      await queuePersistRuntimeData();
      showPatientDetailView({ onLock, homeId, patientId });
    } catch (err) {
      console.error(err);
      alert(err?.message || "Rezept konnte nicht gelöscht werden.");
    }
  };
}

export function showRezeptDetailView({ onLock, homeId, patientId, rezeptId }) {
  bindLockButton(onLock);
  setCurrentView("rezept-detail", { homeId, patientId, rezeptId });

  const runtimeData = getRuntimeData();
  const home = getHomeById(runtimeData, homeId);
  const patient = getPatientById(home, patientId);
  const rezept = getRezeptById(patient, rezeptId);

  if (!home || !patient || !rezept) {
    showPatientDetailView({ onLock, homeId, patientId });
    return;
  }

  const frist = getRezeptFristInfo(rezept);
  const timeEntries = getRezeptTimeEntries(rezept);
  const timeSummary = getRezeptTimeSummary(rezept);

  render(`
    <div class="card">
      <h2>Rezept</h2>
      <p><strong>Patient:</strong> ${escapeHtml(`${patient.firstName} ${patient.lastName}`.trim() || "—")}</p>
      <button id="backPatientBtn" class="secondary">Zurück zum Patienten</button>
    </div>

    <details class="accordion">
      <summary>
        <span>Rezeptdaten</span>
        <span class="muted">${escapeHtml(rezeptSummary(rezept))}</span>
      </summary>
      <div class="accordion-body">
        <p><strong>Leistungen:</strong> ${escapeHtml(rezeptSummary(rezept))}</p>
        <p><strong>Arzt:</strong> ${escapeHtml(rezept.arzt || "—")}</p>
        <p><strong>Ausstellungsdatum:</strong> ${escapeHtml(rezept.ausstell || "—")}</p>
        <p><strong>Status:</strong> ${escapeHtml(rezept.status || "Aktiv")}</p>
        <p><strong>BG:</strong> ${rezept.bg ? "Ja" : "Nein"}</p>
        <p><strong>Doppeltermin:</strong> ${rezept.dt ? "Ja" : "Nein"}</p>
        <p><strong>Zeit gesamt:</strong> ${escapeHtml(formatMinutesLabel(timeSummary.totalMinutes))}</p>
        <p><strong>Zeit-Einträge:</strong> ${timeSummary.totalEntries}</p>
      </div>
    </details>

    <details class="accordion">
      <summary>
        <span>Fristenhinweis</span>
        <span class="muted">${escapeHtml(frist.statusText || "—")}</span>
      </summary>
      <div class="accordion-body">
        <p><strong>Status:</strong> ${escapeHtml(frist.statusText || "—")}</p>
        <p><strong>Hinweis:</strong> ${escapeHtml(frist.detailsText || "—")}</p>
        <p><strong>Spätester Beginn:</strong> ${escapeHtml(frist.latestStartText || "—")}</p>
        <p><strong>Gültig bis:</strong> ${escapeHtml(frist.validUntilText || "—")}</p>
      </div>
    </details>

    <div class="card">
      <h3>Dokumentation zu diesem Rezept</h3>
      <label for="entryDate">Datum</label>
      <input id="entryDate" type="text" placeholder="TT.MM.JJJJ" inputmode="numeric">

      <label for="entryText">Dokumentation</label>
      <input id="entryText" type="text" placeholder="Behandlung / Verlauf / Besonderheiten">

      <p class="muted">Beim Speichern wird die Zeit automatisch aus der Rezeptleistung berechnet.</p>

      <button id="saveEntryBtn">Dokumentation speichern</button>
      <div id="entryMsg"></div>
    </div>

    <details class="accordion">
      <summary>
        <span>Vorhandene Einträge</span>
        <span class="muted">${rezept.entries.length}</span>
      </summary>
      <div class="accordion-body">
        ${rezept.entries.length === 0 ? `<p class="muted">Noch keine Dokumentation zu diesem Rezept.</p>` : ""}
        ${rezept.entries.map(entry => `
          <div class="card" style="margin-bottom:12px;padding:16px;">
            <p><strong>${escapeHtml(entry.date || "Ohne Datum")}</strong></p>
            <p>${escapeHtml(entry.text || "")}</p>
            <p class="muted">Automatische Zeit: ${escapeHtml(formatMinutesLabel(entry.autoTimeMinutes || 0))}</p>
            <button class="editEntryBtn secondary" data-entry-id="${entry.entryId}">Eintrag bearbeiten</button>
          </div>
        `).join("")}
      </div>
    </details>

    <details class="accordion">
      <summary>
        <span>Zeit-Einträge</span>
        <span class="muted">${escapeHtml(formatMinutesLabel(timeSummary.totalMinutes))}</span>
      </summary>
      <div class="accordion-body">
        <p class="muted">Gesamtzeit: ${escapeHtml(formatMinutesLabel(timeSummary.totalMinutes))}</p>
        ${timeEntries.length === 0 ? `<p class="muted">Noch keine Zeit zu diesem Rezept erfasst.</p>` : ""}
        ${timeEntries.map(item => `
          <div class="card" style="margin-bottom:12px;padding:16px;">
            <p><strong>${escapeHtml(item.date || "Ohne Datum")}</strong> · ${escapeHtml(formatMinutesLabel(item.minutes))}</p>
            <p class="muted">Typ: ${escapeHtml(getTimeTypeLabel(item.type))}</p>
            <p class="muted">Status: ${item.confirmed ? "Bestätigt" : "Offen"}</p>
            ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}
            <div class="row" style="margin-top:10px;">
              <button class="deleteTimeEntryBtn secondary" data-time-entry-id="${item.timeEntryId}">Zeiteintrag löschen</button>
            </div>
          </div>
        `).join("")}
      </div>
    </details>
  `);

  document.getElementById("backPatientBtn").onclick = () => {
    showPatientDetailView({ onLock, homeId, patientId });
  };

  bindDateAutoFormat(document.getElementById("entryDate"));

  document.getElementById("saveEntryBtn").onclick = async () => {
    const date = document.getElementById("entryDate").value.trim();
    const text = document.getElementById("entryText").value.trim();
    const msg = document.getElementById("entryMsg");

    msg.className = "error";
    msg.textContent = "";

    if (!text) {
      msg.textContent = "Bitte einen Dokumentationstext eingeben.";
      return;
    }

    try {
      const pendingKm = getPendingKilometerContext(homeId, patientId, date);
      if (pendingKm.needsKmInput) {
        const entered = window.prompt(`Bitte Entfernung eingeben:
${pendingKm.fromLabel} → ${pendingKm.toLabel}`, "");
        if (entered === null) {
          msg.textContent = "Dokumentation abgebrochen, da die Kilometer nicht eingegeben wurden.";
          return;
        }
        const kmValue = Number(String(entered).replace(",", "."));
        if (!Number.isFinite(kmValue) || kmValue <= 0) {
          msg.textContent = "Bitte gültige Kilometer für die neue Strecke eingeben.";
          return;
        }
        saveKnownKilometerRoute({
          fromPointId: pendingKm.fromPointId,
          toPointId: pendingKm.toPointId,
          fromLabel: pendingKm.fromLabel,
          toLabel: pendingKm.toLabel,
          km: kmValue
        });
      }

      createRezeptEntry(homeId, patientId, rezeptId, { date, text });
      await queuePersistRuntimeData();
      showRezeptDetailView({ onLock, homeId, patientId, rezeptId });
    } catch (err) {
      console.error(err);
      msg.textContent = err?.message || "Dokumentation konnte nicht gespeichert werden.";
    }
  };

  document.querySelectorAll(".editEntryBtn").forEach((btn) => {
    btn.onclick = () => {
      showEditRezeptEntryView({
        onLock,
        homeId,
        patientId,
        rezeptId,
        entryId: btn.dataset.entryId
      });
    };
  });

  document.querySelectorAll(".deleteTimeEntryBtn").forEach((btn) => {
    btn.onclick = async () => {
      const ok = window.confirm("Zeiteintrag wirklich löschen?");
      if (!ok) return;

      try {
        deleteRezeptTimeEntry(homeId, patientId, rezeptId, btn.dataset.timeEntryId);
        await queuePersistRuntimeData();
        showRezeptDetailView({ onLock, homeId, patientId, rezeptId });
      } catch (err) {
        console.error(err);
        alert(err?.message || "Zeiteintrag konnte nicht gelöscht werden.");
      }
    };
  });
}

export function showEditRezeptEntryView({ onLock, homeId, patientId, rezeptId, entryId }) {
  bindLockButton(onLock);
  setCurrentView("entry-edit", { homeId, patientId, rezeptId, entryId });

  const runtimeData = getRuntimeData();
  const home = getHomeById(runtimeData, homeId);
  const patient = getPatientById(home, patientId);
  const rezept = getRezeptById(patient, rezeptId);
  const entry = (rezept?.entries || []).find((item) => item.entryId === entryId);

  if (!home || !patient || !rezept || !entry) {
    showRezeptDetailView({ onLock, homeId, patientId, rezeptId });
    return;
  }

  render(`
    <div class="card">
      <h2>Dokumentation bearbeiten</h2>
      <button id="backRezeptBtn" class="secondary">Zurück zum Rezept</button>
    </div>

    <div class="card">
      <label for="entryDate">Datum</label>
      <input id="entryDate" type="text" value="${escapeHtml(entry.date || "")}" inputmode="numeric">

      <label for="entryText">Dokumentation</label>
      <input id="entryText" type="text" value="${escapeHtml(entry.text || "")}">

      <button id="updateEntryBtn">Änderungen speichern</button>
      <div id="entryMsg"></div>
    </div>
  `);

  document.getElementById("backRezeptBtn").onclick = () => {
    showRezeptDetailView({ onLock, homeId, patientId, rezeptId });
  };

  bindDateAutoFormat(document.getElementById("entryDate"));

  document.getElementById("updateEntryBtn").onclick = async () => {
    const msg = document.getElementById("entryMsg");
    msg.className = "error";
    msg.textContent = "";

    const date = document.getElementById("entryDate").value.trim();
    const text = document.getElementById("entryText").value.trim();

    if (!text) {
      msg.textContent = "Bitte einen Dokumentationstext eingeben.";
      return;
    }

    try {
      updateRezeptEntry(homeId, patientId, rezeptId, entryId, { date, text });
      await queuePersistRuntimeData();
      showRezeptDetailView({ onLock, homeId, patientId, rezeptId });
    } catch (err) {
      console.error(err);
      msg.textContent = "Eintrag konnte nicht aktualisiert werden.";
    }
  };
}

function formatAbgabeZusatz(row) {
  const extras = [];
  if (row?.befreit) extras.push("Befreit");
  if (row?.dt) extras.push("Doppelstunde");
  if (row?.bg) extras.push("BG");
  return extras.join(", ");
}

function sortAbgabeRowsForOutput(rows) {
  return [...(rows || [])].sort((a, b) => {
    const last = String(a.patientLastName || "").localeCompare(String(b.patientLastName || ""), "de");
    if (last !== 0) return last;
    const first = String(a.patientFirstName || "").localeCompare(String(b.patientFirstName || ""), "de");
    if (first !== 0) return first;
    const homeCompare = String(a.heim || "").localeCompare(String(b.heim || ""), "de");
    if (homeCompare !== 0) return homeCompare;
    return String(a.leistung || "").localeCompare(String(b.leistung || ""), "de");
  });
}


function renderAbgabeSheetHtml(rows, options = {}) {
  const normalizedRows = sortAbgabeRowsForOutput(rows || []);
  const therapistName = String(options?.therapistName || "").trim() || "—";
  const createdAtLabel = formatIsoDateShort(options?.createdAt);

  return `
    <div style="border-bottom:1px solid #d1d5db; padding:0 0 12px 0; margin-bottom:14px;">
      <div><strong>Therapeut:</strong> ${escapeHtml(therapistName)}</div>
      <div><strong>Erstellt am:</strong> ${escapeHtml(createdAtLabel)}</div>
    </div>
    ${normalizedRows.map((row) => `
      <div class="row">
        <strong>${escapeHtml(row.patient || "—")}</strong> · ${escapeHtml(row.heim || "—")}<br>
        <span class="muted">Arzt: ${escapeHtml(row.arzt || "—")}</span><br>
        <span class="muted">Ausstellung: ${escapeHtml(row.ausstell || "—")}</span><br>
        <span class="muted">Leistung: ${escapeHtml(row.leistung || "—")} ${escapeHtml(row.anzahl || "")}</span><br>
        ${formatAbgabeZusatz(row) ? `<span class="muted">${escapeHtml(formatAbgabeZusatz(row))}</span>` : ""}
      </div>
    `).join("")}
  `;
}

export function showAbgabeView({ onLock, searchText = "", selectedIds = [] }) {
  bindLockButton(onLock);
  setCurrentView("abgabe", { searchText, selectedIds });

  const data = getRuntimeData();
  const tree = buildAbgabeTree(data);
  const allRows = buildAbgabeRows(data);
  const filteredRows = filterAbgabeRows(allRows, searchText);
  const allowedIds = new Set(filteredRows.map((row) => row.rowId));
  const selected = new Set(selectedIds);

  render(`
    <div class="card">
      <h2>Abgabeliste</h2>
      <button id="backDashboardBtn" class="secondary">Zurück zum Dashboard</button>
    </div>

    <details class="accordion">
      <summary>
        <span>Suche</span>
        <span class="muted">Filter</span>
      </summary>
      <div class="accordion-body">
        <input id="abgabeSearch" type="text" value="${escapeHtml(searchText)}" placeholder="Patient, Heim, Leistung, Arzt">
        <div class="row">
          <button id="runAbgabeSearchBtn" class="secondary">Suchen</button>
          <button id="clearAbgabeSearchBtn" class="secondary">Suche löschen</button>
        </div>
      </div>
    </details>

    <div class="card">
      <h3>Abgabe-Auswahl</h3>

      ${tree.length === 0 ? `<p class="muted">Noch keine Rezeptdaten vorhanden.</p>` : `
        <div class="list-stack">
          ${tree.map(home => {
            const patientBlocks = home.patients.map(patient => {
              const rezeptRows = patient.rezepte.filter((row) => !searchText || allowedIds.has(row.rowId));
              if (rezeptRows.length === 0) return "";

              return `
                <details class="accordion" style="margin-bottom:10px;">
                  <summary>
                    <span>${escapeHtml(patient.patientName || "Patient")}</span>
                    <span class="muted">${rezeptRows.length} Rezeptzeile(n)</span>
                  </summary>
                  <div class="accordion-body">
                    <div class="compact-meta" style="margin-bottom:10px;">
                      Geburt: ${escapeHtml(patient.geb || "—")}
                    </div>

                    ${rezeptRows.map(row => `
                      <div class="compact-card selectable-card">
                        <label style="display:flex; gap:10px; align-items:flex-start; font-weight:normal;">
                          <input class="abgabeCheck" type="checkbox" data-row-id="${row.rowId}" style="width:auto;" ${selected.has(row.rowId) ? "checked" : ""}>
                          <span>
                            <strong>${escapeHtml(row.leistung || "—")} ${escapeHtml(row.anzahl || "")}</strong><br>
                            <span class="muted">Arzt: ${escapeHtml(row.arzt || "—")}</span><br>
                            <span class="muted">Ausstellung: ${escapeHtml(row.ausstell || "—")}</span><br>
                            ${formatAbgabeZusatz(row) ? `<span class="muted">${escapeHtml(formatAbgabeZusatz(row))}</span>` : ""}
                          </span>
                        </label>
                      </div>
                    `).join("")}
                  </div>
                </details>
              `;
            }).filter(Boolean).join("");

            if (!patientBlocks) return "";

            return `
              <details class="accordion">
                <summary>
                  <span>${escapeHtml(home.homeName || "Heim")}</span>
                  <span class="muted">${home.patients.length} Patient(en)</span>
                </summary>
                <div class="accordion-body">
                  ${patientBlocks}
                </div>
              </details>
            `;
          }).join("")}
        </div>
      `}

      <div class="row" style="margin-top:12px;">
        <button id="saveAbgabeSelectionBtn">Auswahl speichern</button>
        <button id="printAbgabeSelectionBtn" class="secondary">Auswahl drucken</button>
      </div>

      <div id="abgabeMsg"></div>
    </div>

    <details class="accordion">
      <summary>
        <span>Abgabe-Historie</span>
        <span class="muted">${(data.abgabeHistory || []).length}</span>
      </summary>
      <div class="accordion-body">
        ${((data.abgabeHistory || []).length === 0) ? `<p class="muted">Noch keine gespeicherten Listen.</p>` : ""}
        ${(data.abgabeHistory || []).slice(0, 20).map(item => `
          <div class="compact-card">
            <div style="font-weight:600;">${escapeHtml(item.title || "Abgabeliste")}</div>
            <div class="compact-meta">
              Datum: ${escapeHtml(formatIsoDateShort(item.createdAt))}<br>
              ${item.rows?.length || 0} Zeile(n)
            </div>
            <div class="row" style="margin-top:10px;">
              <button class="secondary abgabe-history-open-btn" data-history-id="${escapeHtml(item.id)}">Öffnen</button>
              <button class="secondary abgabe-history-print-btn" data-history-id="${escapeHtml(item.id)}">Drucken</button>
              <button class="secondary abgabe-history-delete-btn" data-history-id="${escapeHtml(item.id)}">Löschen</button>
            </div>
          </div>
        `).join("")}
      </div>
    </details>
  `);

  bindSelectableCardChecks(app);

  document.getElementById("backDashboardBtn").onclick = () => showDashboardView({ onLock });

  document.getElementById("runAbgabeSearchBtn").onclick = () => {
    const value = document.getElementById("abgabeSearch").value;
    const nextSelected = Array.from(document.querySelectorAll(".abgabeCheck:checked")).map((el) => el.dataset.rowId);
    showAbgabeView({ onLock, searchText: value, selectedIds: nextSelected });
  };

  document.getElementById("clearAbgabeSearchBtn").onclick = () => {
    showAbgabeView({ onLock, searchText: "", selectedIds: [] });
  };

  document.getElementById("saveAbgabeSelectionBtn").onclick = async () => {
    const msg = document.getElementById("abgabeMsg");
    msg.className = "error";
    msg.textContent = "";

    const chosenIds = Array.from(document.querySelectorAll(".abgabeCheck:checked")).map((el) => el.dataset.rowId);
    const chosenRows = sortAbgabeRowsForOutput(allRows.filter((row) => chosenIds.includes(row.rowId)));

    if (chosenRows.length === 0) {
      msg.textContent = "Bitte mindestens einen Eintrag auswählen.";
      return;
    }

    try {
      const createdAt = new Date().toISOString();
      const therapistName = String(getRuntimeData()?.settings?.therapistName || "").trim() || "—";
      const bodyHtml = renderAbgabeSheetHtml(chosenRows, { therapistName, createdAt });
      saveAbgabeHistory(`Abgabeliste ${formatIsoDateShort(createdAt)}`, chosenRows, {
        createdAt,
        snapshotHtml: bodyHtml
      });
      await queuePersistRuntimeData();
      showAbgabeView({ onLock, searchText, selectedIds: [] });
    } catch (err) {
      console.error(err);
      msg.textContent = "Abgabe-Historie konnte nicht gespeichert werden.";
    }
  };

  document.getElementById("printAbgabeSelectionBtn").onclick = () => {
    const chosenIds = Array.from(document.querySelectorAll(".abgabeCheck:checked")).map((el) => el.dataset.rowId);
    const chosenRows = sortAbgabeRowsForOutput(allRows.filter((row) => chosenIds.includes(row.rowId)));

    if (chosenRows.length === 0) {
      alert("Bitte mindestens einen Eintrag auswählen.");
      return;
    }

    const therapistName = String(getRuntimeData()?.settings?.therapistName || "").trim() || "—";
    const bodyHtml = renderAbgabeSheetHtml(chosenRows, {
      therapistName,
      createdAt: new Date().toISOString()
    });

    openHtmlDocument("Abgabeliste", bodyHtml, { autoPrint: true });
  };

  document.querySelectorAll('.abgabe-history-open-btn').forEach((button) => {
    button.onclick = () => {
      const historyId = button.dataset.historyId || '';
      const item = (getRuntimeData().abgabeHistory || []).find((entry) => entry.id === historyId);
      if (!item) return;
      const therapistName = String(getRuntimeData()?.settings?.therapistName || "").trim() || "—";
      const bodyHtml = item.snapshotHtml || renderAbgabeSheetHtml(item.rows || [], {
        therapistName,
        createdAt: item.createdAt
      });
      openLetterPreview(item.title || 'Abgabeliste', bodyHtml);
    };
  });

  document.querySelectorAll('.abgabe-history-print-btn').forEach((button) => {
    button.onclick = () => {
      const historyId = button.dataset.historyId || '';
      const item = (getRuntimeData().abgabeHistory || []).find((entry) => entry.id === historyId);
      if (!item) return;
      const therapistName = String(getRuntimeData()?.settings?.therapistName || "").trim() || "—";
      const bodyHtml = item.snapshotHtml || renderAbgabeSheetHtml(item.rows || [], {
        therapistName,
        createdAt: item.createdAt
      });
      openHtmlDocument(item.title || 'Abgabeliste', bodyHtml, { autoPrint: true });
    };
  });

  document.querySelectorAll('.abgabe-history-delete-btn').forEach((button) => {
    button.onclick = async () => {
      const historyId = button.dataset.historyId || '';
      if (!historyId) return;
      if (!confirm('Diesen Abgabe-Historieneintrag wirklich löschen?')) return;
      deleteAbgabeHistoryItem(historyId);
      await queuePersistRuntimeData();
      showAbgabeView({ onLock, searchText, selectedIds: [] });
    };
  });
}

export function showNachbestellungView({ onLock, doctorFilter = "", textFilter = "", selectedIds = [] }) {
  bindLockButton(onLock);

  const data = getRuntimeData();
  const doctors = getDoctorList(data);
  const allRows = buildNachbestellRows(data);
  const filteredRows = filterNachbestellRows(allRows, doctorFilter, textFilter);
  const normalizedSelectedIds = normalizeSelectedRowIds(selectedIds, filteredRows);
  const tree = buildNachbestellTree(data, doctorFilter, textFilter);
  const selected = new Set(normalizedSelectedIds);

  setCurrentView("nachbestellung", { doctorFilter, textFilter, selectedIds: normalizedSelectedIds });

  render(`
    <div class="card">
      <h2>Nachbestellung</h2>
      <button id="backDashboardBtn" class="secondary">Zurück zum Dashboard</button>
    </div>

    <details class="accordion">
      <summary>
        <span>Filter</span>
        <span class="muted">Arzt / Suche</span>
      </summary>
      <div class="accordion-body">
        <label for="doctorFilter">Arzt</label>
        <input id="doctorFilter" list="doctorList" value="${escapeHtml(doctorFilter)}" placeholder="Arztname eingeben oder wählen">
        <datalist id="doctorList">
          ${doctors.map((doctor) => `<option value="${escapeHtml(doctor)}"></option>`).join("")}
        </datalist>

        <label for="nachbestellTextFilter">Zusätzliche Suche</label>
        <input id="nachbestellTextFilter" type="text" value="${escapeHtml(textFilter)}" placeholder="Patient, Heim, Status, Text">

        <div class="row">
          <button id="runDoctorFilterBtn" class="secondary">Filtern</button>
          <button id="clearDoctorFilterBtn" class="secondary">Filter löschen</button>
        </div>
      </div>
    </details>

    <div class="card">
      <h3>Nachbestell-Auswahl</h3>

      ${tree.length === 0 ? `<p class="muted">Keine passenden Einträge vorhanden.</p>` : `
        <div class="list-stack">
          ${tree.map((group) => `
            <details class="accordion">
              <summary>
                <span>${escapeHtml(group.doctor || "Ohne Arzt")}</span>
                <span class="muted">${group.patients.length} Patient(en)</span>
              </summary>
              <div class="accordion-body">
                ${group.patients.map((patient) => `
                  <details class="accordion" style="margin-bottom:10px;">
                    <summary>
                      <span>${escapeHtml(patient.patient || "Patient")}</span>
                      <span class="muted">${patient.rows.length} Rezept(e)</span>
                    </summary>
                    <div class="accordion-body">
                      <div class="compact-meta" style="margin-bottom:10px;">
                        Heim: ${escapeHtml(patient.heim || "—")}<br>
                        Geburt: ${escapeHtml(patient.geb || "—")}
                      </div>

                      ${patient.rows.map((row) => `
                        <div class="compact-card selectable-card ${selected.has(row.rowId) ? "is-selected" : ""}">
                          <label style="display:flex; gap:10px; align-items:flex-start; font-weight:normal; width:100%; cursor:pointer;">
                            <input class="nachbestellCheck" type="checkbox" data-row-id="${row.rowId}" style="width:auto;" ${selected.has(row.rowId) ? "checked" : ""}>
                            <span>
                              <strong>${escapeHtml(row.text || "—")}</strong><br>
                              <span class="muted">Ausstellung: ${escapeHtml(row.ausstell || "—")}</span><br>
                              ${formatAbgabeZusatz(row) ? `<span class="muted">${escapeHtml(formatAbgabeZusatz(row))}</span>` : ""}
                            </span>
                          </label>
                        </div>
                      `).join("")}
                    </div>
                  </details>
                `).join("")}
              </div>
            </details>
          `).join("")}
        </div>
      `}

      <div class="row" style="margin-top:12px;">
        <button id="createNachbestellLetterBtn">Nachbestellzettel erzeugen</button>
        <button id="printNachbestellSelectionBtn" class="secondary">Aktuelle Auswahl drucken</button>
      </div>

      <div id="nachbestellMsg"></div>
    </div>

    <details class="accordion">
      <summary>
        <span>Nachbestell-Historie</span>
        <span class="muted">${(data.nachbestellHistory || []).length}</span>
      </summary>
      <div class="accordion-body">
        ${((data.nachbestellHistory || []).length === 0) ? `<p class="muted">Noch keine gespeicherten Nachbestellzettel.</p>` : ""}
        ${(data.nachbestellHistory || []).slice(0, 20).map((item) => `
          <div class="compact-card">
            <div style="font-weight:600;">${escapeHtml(item.title || "Nachbestellung")}</div>
            <div class="compact-meta">
              Arzt: ${escapeHtml(item.doctor || "—")}<br>
              Datum: ${escapeHtml(formatIsoDateShort(item.createdAt))}<br>
              ${Number(item.patientCount || 0)} Patient(en) · ${Number(item.rezeptCount || item.lines?.length || 0)} Rezept(e)
            </div>
            <div class="row" style="margin-top:10px;">
              <button class="secondary history-open-btn" data-history-id="${escapeHtml(item.id)}">Öffnen</button>
              <button class="secondary history-print-btn" data-history-id="${escapeHtml(item.id)}">Drucken</button>
              <button class="secondary history-delete-btn" data-history-id="${escapeHtml(item.id)}">Löschen</button>
            </div>
          </div>
        `).join("")}
      </div>
    </details>
  `);

  function getChosenRows() {
    const chosenIds = getCheckedRowIds(".nachbestellCheck", app);
    return filteredRows.filter((row) => chosenIds.includes(row.rowId));
  }

  function buildCurrentLetter() {
    const chosenRows = getChosenRows();
    if (chosenRows.length === 0) throw new Error("Bitte mindestens einen Eintrag auswählen.");
    const letterData = buildNachbestellLetterData(getRuntimeData(), chosenRows);
    return {
      letterData,
      bodyHtml: renderNachbestellLetterHtml(letterData),
      lines: flattenNachbestellLines(letterData)
    };
  }

  document.getElementById("backDashboardBtn").onclick = () => showDashboardView({ onLock });

  document.getElementById("runDoctorFilterBtn").onclick = () => {
    const doctorValue = document.getElementById("doctorFilter").value;
    const textValue = document.getElementById("nachbestellTextFilter").value;
    const nextSelected = getCheckedRowIds(".nachbestellCheck", app);

    showNachbestellungView({
      onLock,
      doctorFilter: doctorValue,
      textFilter: textValue,
      selectedIds: nextSelected
    });
  };

  document.getElementById("clearDoctorFilterBtn").onclick = () => {
    showNachbestellungView({
      onLock,
      doctorFilter: "",
      textFilter: "",
      selectedIds: []
    });
  };

  bindSelectableCardChecks(app);

  document.querySelectorAll('.nachbestellCheck').forEach((check) => {
    if (check.dataset.boundSelectionState === '1') return;
    check.dataset.boundSelectionState = '1';
    check.addEventListener('change', () => {
      const nextSelected = getCheckedRowIds('.nachbestellCheck', app);
      setCurrentView('nachbestellung', { doctorFilter, textFilter, selectedIds: nextSelected });
    });
  });

  document.getElementById("createNachbestellLetterBtn").onclick = async () => {
    const msg = document.getElementById("nachbestellMsg");
    msg.className = "error";
    msg.textContent = "";

    try {
      const { letterData, bodyHtml, lines } = buildCurrentLetter();
      saveNachbestellHistorySnapshot({
        title: `Nachbestellung ${letterData.doctor} · ${formatIsoDateShort(letterData.createdAt)}`,
        doctor: letterData.doctor,
        createdAt: letterData.createdAt,
        rezeptCount: letterData.rezeptCount,
        patientCount: letterData.patientCount,
        snapshotHtml: bodyHtml,
        lines
      });
      await queuePersistRuntimeData();
      openLetterPreview(letterData.title, bodyHtml);
      showNachbestellungView({
        onLock,
        doctorFilter: "",
        textFilter: "",
        selectedIds: []
      });
    } catch (err) {
      console.error(err);
      msg.textContent = err?.message || "Nachbestellzettel konnte nicht erzeugt werden.";
    }
  };

  document.getElementById("printNachbestellSelectionBtn").onclick = () => {
    try {
      const { letterData, bodyHtml } = buildCurrentLetter();
      openHtmlDocument(letterData.title, bodyHtml, { autoPrint: true });
    } catch (err) {
      alert(err?.message || 'Nachbestellzettel konnte nicht gedruckt werden.');
    }
  };

  document.querySelectorAll('.history-open-btn').forEach((button) => {
    button.onclick = () => {
      const historyId = button.dataset.historyId || '';
      const item = (getRuntimeData().nachbestellHistory || []).find((entry) => entry.id === historyId);
      if (!item?.snapshotHtml) {
        alert('Dieser Historieneintrag enthält keinen gespeicherten Zettel.');
        return;
      }
      openLetterPreview(item.title || 'Nachbestellung', item.snapshotHtml);
    };
  });

  document.querySelectorAll('.history-print-btn').forEach((button) => {
    button.onclick = () => {
      const historyId = button.dataset.historyId || '';
      const item = (getRuntimeData().nachbestellHistory || []).find((entry) => entry.id === historyId);
      if (!item?.snapshotHtml) {
        alert('Dieser Historieneintrag enthält keinen gespeicherten Zettel.');
        return;
      }
      openHtmlDocument(item.title || 'Nachbestellung', item.snapshotHtml, { autoPrint: true });
    };
  });

  document.querySelectorAll('.history-delete-btn').forEach((button) => {
    button.onclick = async () => {
      const historyId = button.dataset.historyId || '';
      if (!historyId) return;
      if (!confirm('Diesen Nachbestell-Historieneintrag wirklich löschen?')) return;
      deleteNachbestellHistoryItem(historyId);
      await queuePersistRuntimeData();
      showNachbestellungView({ onLock, doctorFilter, textFilter, selectedIds: normalizedSelectedIds });
    };
  });
}

export function showKilometerView({ onLock, summaryFrom = "", summaryTo = "", editTravelId = "" }) {
  bindLockButton(onLock);
  setCurrentView("kilometer", { summaryFrom, summaryTo, editTravelId });

  const overview = getKilometerOverview();
  const pointOptions = getKilometerPointOptions();
  const summary = getKilometerPeriodSummary(summaryFrom, summaryTo);

  const travelLog = [...(overview.travelLog || [])].sort((a, b) =>
    compareDeDates(String(b?.date || ""), String(a?.date || ""))
    || collatorDE.compare(String(b?.createdAt || ""), String(a?.createdAt || ""))
  );
  const editingItem = editTravelId ? travelLog.find((item) => item.travelId === editTravelId) || null : null;
  const formTitle = editingItem ? "Fahrt bearbeiten" : "Manuelle Fahrt ergänzen";
  const formHint = editingItem
    ? "Kilometer, Datum und Strecke dieser Fahrt können hier korrigiert werden."
    : "Für Ausnahmefälle wie zusätzliche Wechsel zwischen Einrichtungen. Begründung ist Pflicht.";
  const formButtonLabel = editingItem ? "Fahrt aktualisieren" : "Manuelle Fahrt speichern";
  const formDateValue = editingItem?.date || summaryTo || summaryFrom || "";
  const formFromValue = editingItem?.fromPointId || "";
  const formToValue = editingItem?.toPointId || "";
  const formKmValue = editingItem ? String(editingItem.km ?? "") : "";
  const formReasonValue = editingItem?.note || "";

  render(`
    <div class="card">
      <h2>Kilometer</h2>
      <button id="backDashboardBtn" class="secondary">Zurück zum Dashboard</button>
    </div>

    <details class="accordion" ${editingItem ? 'open' : ''}>
      <summary>
        <span>${escapeHtml(formTitle)}</span>
        <span class="muted">${editingItem ? 'Korrektur' : 'Ausnahmefälle'}</span>
      </summary>
      <div class="accordion-body">
      <h3>${escapeHtml(formTitle)}</h3>
      <p class="muted">${escapeHtml(formHint)}</p>

      <label for="manualKmDate">Datum</label>
      <input id="manualKmDate" type="text" value="${escapeHtml(formDateValue)}" placeholder="TT.MM.JJJJ">

      <label for="manualKmFrom">Von</label>
      <select id="manualKmFrom">
        <option value="">Bitte wählen</option>
        ${pointOptions.map((point) => `<option value="${escapeHtml(point.pointId)}" ${point.pointId === formFromValue ? 'selected' : ''}>${escapeHtml(point.label)}${point.address ? ` – ${escapeHtml(point.address)}` : ""}</option>`).join("")}
      </select>

      <label for="manualKmTo">Nach</label>
      <select id="manualKmTo">
        <option value="">Bitte wählen</option>
        ${pointOptions.map((point) => `<option value="${escapeHtml(point.pointId)}" ${point.pointId === formToValue ? 'selected' : ''}>${escapeHtml(point.label)}${point.address ? ` – ${escapeHtml(point.address)}` : ""}</option>`).join("")}
      </select>

      <label for="manualKmValue">Kilometer</label>
      <input id="manualKmValue" type="number" min="0" step="0.1" value="${escapeHtml(formKmValue)}" placeholder="z.B. 7.5">

      <label for="manualKmReason">Begründung</label>
      <input id="manualKmReason" type="text" value="${escapeHtml(formReasonValue)}" placeholder="z.B. viele Ausfälle, Patienten später, Krankenhaus">

      <div class="row">
        <button id="saveManualKmBtn">${escapeHtml(formButtonLabel)}</button>
        ${editingItem ? '<button id="cancelKmEditBtn" class="secondary">Bearbeitung abbrechen</button>' : ''}
      </div>
      <div id="manualKmMsg"></div>
      </div>
    </details>

    <details class="accordion">
      <summary>
        <span>Fahrtenprotokoll</span>
        <span class="muted">${travelLog.length}</span>
      </summary>
      <div class="accordion-body">
        ${travelLog.length === 0 ? `<p class="muted">Noch keine Fahrten protokolliert.</p>` : ""}
        ${travelLog.map((item) => `
          <div class="compact-card">
            <div style="font-weight:600;">${escapeHtml(item.date || "Ohne Datum")} · ${escapeHtml(formatKm(item.km || 0))}</div>
            <div class="compact-meta">${escapeHtml(item.fromLabel || "—")} → ${escapeHtml(item.toLabel || "—")}</div>
            <div class="compact-meta">Typ: ${item.source === "auto" ? "Automatisch" : "Manuell"}${item.manualAdjusted ? ' · manuell korrigiert' : ''}</div>
            ${item.note ? `<div class="compact-meta">${escapeHtml(item.note)}</div>` : ""}
            <div class="row" style="margin-top:10px;">
              <button class="secondary editTravelBtn" data-travel-id="${escapeHtml(item.travelId || "")}">Fahrt bearbeiten</button>
              <button class="secondary deleteTravelBtn" data-travel-id="${escapeHtml(item.travelId || "")}">Fahrt löschen</button>
            </div>
          </div>
        `).join("")}
      </div>
    </details>

    <details class="accordion">
      <summary>
        <span>Startpunkt</span>
        <span class="muted">${escapeHtml(overview.startPoint?.label || "nicht gesetzt")}</span>
      </summary>
      <div class="accordion-body">
        <label for="kmStartLabel">Bezeichnung</label>
        <input id="kmStartLabel" type="text" value="${escapeHtml(overview.startPoint?.label || "Startpunkt")}">

        <label for="kmStartAddress">Adresse</label>
        <input id="kmStartAddress" type="text" value="${escapeHtml(overview.startPoint?.address || "")}" placeholder="z.B. Musterstraße 1, Ingolstadt">

        <button id="saveStartPointBtn">Startpunkt speichern</button>
        <div id="kilometerMsg"></div>
      </div>
    </details>

    <details class="accordion">
      <summary>
        <span>Zeitraum-Auswertung</span>
        <span class="muted">${escapeHtml(formatKm(summary.totalKm))} · ${escapeHtml(formatEuro(summary.totalAmount))}</span>
      </summary>
      <div class="accordion-body">
        <label for="kmSummaryFrom">Von</label>
        <input id="kmSummaryFrom" type="text" value="${escapeHtml(summaryFrom)}" placeholder="TT.MM.JJJJ">

        <label for="kmSummaryTo">Bis</label>
        <input id="kmSummaryTo" type="text" value="${escapeHtml(summaryTo)}" placeholder="TT.MM.JJJJ">

        <div class="row">
          <button id="runKmSummaryBtn">Auswertung anzeigen</button>
          <button id="printKmSummaryBtn" class="secondary">Kilometerzettel drucken</button>
        </div>

        <div class="compact-card" style="margin-top:12px;">
          <div style="font-weight:600;">Kilometerkonto</div>
          <div class="compact-meta">Gesamtkilometer: ${escapeHtml(formatKm(summary.totalKm))}</div>
          <div class="compact-meta">Vergütung: ${escapeHtml(formatEuro(summary.totalAmount))}</div>
          <div class="compact-meta">Zeitraum: ${escapeHtml(summary.fromDate || "—")} bis ${escapeHtml(summary.toDate || "—")}</div>
        </div>

        ${summary.rows.length === 0 ? `<p class="muted" style="margin-top:10px;">Keine Fahrten im gewählten Zeitraum.</p>` : ""}
        ${summary.rows.map((item) => `
          <div class="compact-card">
            <div style="font-weight:600;">${escapeHtml(item.date || "Ohne Datum")} · ${escapeHtml(formatKm(item.km || 0))}</div>
            <div class="compact-meta">${escapeHtml(item.fromLabel || "—")} → ${escapeHtml(item.toLabel || "—")}</div>
            <div class="compact-meta">Typ: ${item.source === "manual" ? "Manuell" : "Automatisch"}${item.manualAdjusted ? ' · manuell korrigiert' : ''}</div>
            ${item.note ? `<div class="compact-meta">Begründung: ${escapeHtml(item.note)}</div>` : ""}
          </div>
        `).join("")}
      </div>
    </details>
  `);

  bindSelectableCardChecks(app);

  document.getElementById("backDashboardBtn").onclick = () => showDashboardView({ onLock });

  document.getElementById("saveStartPointBtn").onclick = async () => {
    const label = document.getElementById("kmStartLabel").value.trim() || "Startpunkt";
    const address = document.getElementById("kmStartAddress").value.trim();
    const msg = document.getElementById("kilometerMsg");

    msg.className = "error";
    msg.textContent = "";

    if (!address) {
      msg.textContent = "Bitte eine Startadresse eingeben.";
      return;
    }

    try {
      saveKilometerStartPoint({ label, address });
      await queuePersistRuntimeData();
      showKilometerView({ onLock, summaryFrom, summaryTo, editTravelId });
    } catch (err) {
      console.error(err);
      msg.textContent = "Startpunkt konnte nicht gespeichert werden.";
    }
  };

  document.getElementById("runKmSummaryBtn").onclick = () => {
    const fromValue = document.getElementById("kmSummaryFrom").value.trim();
    const toValue = document.getElementById("kmSummaryTo").value.trim();
    showKilometerView({ onLock, summaryFrom: fromValue, summaryTo: toValue });
  };

  document.getElementById("printKmSummaryBtn").onclick = () => {
    const fromValue = document.getElementById("kmSummaryFrom").value.trim();
    const toValue = document.getElementById("kmSummaryTo").value.trim();
    const currentSummary = getKilometerPeriodSummary(fromValue, toValue);

    printHtml(
      "Kilometerzettel",
      `
        <div class="row"><strong>Zeitraum:</strong> ${escapeHtml(fromValue || "—")} bis ${escapeHtml(toValue || "—")}</div>
        <div class="row"><strong>Gesamtkilometer:</strong> ${escapeHtml(formatKm(currentSummary.totalKm))}</div>
        <div class="row"><strong>Vergütung:</strong> ${escapeHtml(formatEuro(currentSummary.totalAmount))}</div>
        ${currentSummary.rows.map((item) => `
          <div class="row">
            <strong>${escapeHtml(item.date || "Ohne Datum")}</strong> · ${escapeHtml(formatKm(item.km || 0))}<br>
            <span class="muted">${escapeHtml(item.fromLabel || "—")} → ${escapeHtml(item.toLabel || "—")}</span><br>
            <span class="muted">Typ: ${item.source === "manual" ? "Manuell" : "Automatisch"}${item.manualAdjusted ? ' · manuell korrigiert' : ''}</span>
            ${item.note ? `<br><span class="muted">Begründung: ${escapeHtml(item.note)}</span>` : ""}
          </div>
        `).join("")}
      `
    );
  };

  document.getElementById("saveManualKmBtn").onclick = async () => {
    const msg = document.getElementById("manualKmMsg");
    msg.className = "error";
    msg.textContent = "";

    try {
      const payload = {
        date: document.getElementById("manualKmDate").value.trim(),
        fromPointId: document.getElementById("manualKmFrom").value,
        toPointId: document.getElementById("manualKmTo").value,
        km: document.getElementById("manualKmValue").value,
        note: document.getElementById("manualKmReason").value.trim()
      };

      if (editingItem) {
        updateKilometerTravel(editingItem.travelId, payload);
      } else {
        addManualKilometerTravel(payload);
      }

      await queuePersistRuntimeData();
      showKilometerView({ onLock, summaryFrom, summaryTo });
    } catch (err) {
      console.error(err);
      msg.textContent = err?.message || (editingItem ? "Fahrt konnte nicht aktualisiert werden." : "Manuelle Fahrt konnte nicht gespeichert werden.");
    }
  };

  if (editingItem) {
    document.getElementById("cancelKmEditBtn").onclick = () => {
      showKilometerView({ onLock, summaryFrom, summaryTo });
    };
  }

  document.querySelectorAll(".editTravelBtn").forEach((btn) => {
    btn.onclick = () => {
      showKilometerView({ onLock, summaryFrom, summaryTo, editTravelId: btn.dataset.travelId || "" });
    };
  });

  document.querySelectorAll(".deleteTravelBtn").forEach((btn) => {
    btn.onclick = async () => {
      const ok = window.confirm("Diese Fahrt wirklich löschen?");
      if (!ok) return;

      try {
        deleteKilometerTravel(btn.dataset.travelId);
        await queuePersistRuntimeData();
        showKilometerView({ onLock, summaryFrom, summaryTo, editTravelId: editTravelId === (btn.dataset.travelId || '') ? '' : editTravelId });
      } catch (err) {
        console.error(err);
        alert(err?.message || "Fahrt konnte nicht gelöscht werden.");
      }
    };
  });
}

export function performLock({ onLocked }) {
  clearRuntimeSession();
  onLocked();
}

export function resumeCurrentView({ onLock }) {
  const view = getCurrentView();
  const context = getCurrentContext();

  if (view === "homes") {
    return showHomesView({ onLock, searchText: context.searchText || "" });
  }

  if (view === "home-detail") {
    return showHomeDetailView({
      onLock,
      homeId: context.homeId,
      searchText: context.searchText || ""
    });
  }

  if (view === "patient-detail") {
    return showPatientDetailView({
      onLock,
      homeId: context.homeId,
      patientId: context.patientId
    });
  }

  if (view === "rezept-create") {
    return showCreateRezeptView({
      onLock,
      homeId: context.homeId,
      patientId: context.patientId
    });
  }

  if (view === "rezept-edit") {
    return showEditRezeptView({
      onLock,
      homeId: context.homeId,
      patientId: context.patientId,
      rezeptId: context.rezeptId
    });
  }

  if (view === "rezept-detail") {
    return showRezeptDetailView({
      onLock,
      homeId: context.homeId,
      patientId: context.patientId,
      rezeptId: context.rezeptId
    });
  }

  if (view === "entry-edit") {
    return showEditRezeptEntryView({
      onLock,
      homeId: context.homeId,
      patientId: context.patientId,
      rezeptId: context.rezeptId,
      entryId: context.entryId
    });
  }

  if (view === "doctor-report-editor") {
    return showDoctorReportEditorView({
      onLock,
      homeId: context.homeId,
      patientId: context.patientId,
      rezeptId: context.rezeptId,
      reportId: context.reportId,
      searchText: context.searchText || ""
    });
  }

  if (view === "abgabe") {
    return showAbgabeView({
      onLock,
      searchText: context.searchText || "",
      selectedIds: context.selectedIds || []
    });
  }

  if (view === "nachbestellung") {
    return showNachbestellungView({
      onLock,
      doctorFilter: context.doctorFilter || "",
      textFilter: context.textFilter || "",
      selectedIds: context.selectedIds || []
    });
  }

  if (view === "kilometer") {
    return showKilometerView({ onLock, summaryFrom: context.summaryFrom || "", summaryTo: context.summaryTo || "", editTravelId: context.editTravelId || "" });
  }

  if (view === "settings") {
    return showSettingsView({ onLock });
  }

  showDashboardView({ onLock });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
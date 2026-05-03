function parseDEDateToDate(str) {
  const s = String(str || "").trim();
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);

  const d = new Date(yyyy, mm - 1, dd);
  if (
    d.getFullYear() !== yyyy ||
    d.getMonth() !== mm - 1 ||
    d.getDate() !== dd
  ) {
    return null;
  }

  return d;
}

function formatDateDE(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function addMonthsSafe(date, months) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);

  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function totalAnwendungsmenge(items) {
  let sum = 0;

  (items || []).forEach((item) => {
    if (!item || item.type === "Blanko") return;
    const n = Number(item.count);
    if (Number.isFinite(n)) sum += n;
  });

  return sum;
}

function isBlanko(rezept) {
  return (rezept?.items || []).some((item) => item.type === "Blanko");
}

function diffDays(fromDate, toDate) {
  const ms = toDate.getTime() - fromDate.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

function getTrafficLevel(daysRemaining) {
  if (daysRemaining <= 7) return "red";
  if (daysRemaining <= 21) return "orange";
  return "green";
}

export function getRezeptFristInfo(rezept) {
  const today = new Date();
  const ausstellDate = parseDEDateToDate(rezept?.ausstell || "");

  if (!ausstellDate) {
    return {
      mode: "unknown",
      statusText: "Ausstellungsdatum fehlt",
      detailsText: "Fristen nicht berechenbar",
      latestStartText: null,
      validUntilText: null,
      traffic: "red",
      daysRemaining: null
    };
  }

  if (rezept?.bg) {
    const latestStart = addDays(ausstellDate, 14);
    const validUntil = addMonthsSafe(ausstellDate, 2);
    const daysRemaining = diffDays(today, latestStart);

    return {
      mode: "bg",
      statusText: `Beginn bis ${formatDateDE(latestStart)}`,
      detailsText: "BG: Beginn innerhalb 14 Tagen · gültig 2 Monate ab Ausstellungsdatum",
      latestStartText: formatDateDE(latestStart),
      validUntilText: formatDateDE(validUntil),
      traffic: getTrafficLevel(daysRemaining),
      daysRemaining
    };
  }

  if (isBlanko(rezept)) {
    const latestStart = addDays(ausstellDate, 28);
    const validUntil = addMonthsSafe(ausstellDate, 4);
    const daysRemaining = diffDays(today, latestStart);

    return {
      mode: "blanko",
      statusText: `Beginn bis ${formatDateDE(latestStart)}`,
      detailsText: "Blanko: Beginn innerhalb 28 Tagen · gültig 4 Monate ab Ausstellungsdatum",
      latestStartText: formatDateDE(latestStart),
      validUntilText: formatDateDE(validUntil),
      traffic: getTrafficLevel(daysRemaining),
      daysRemaining
    };
  }

  const latestStart = addDays(ausstellDate, 28);
  const total = totalAnwendungsmenge(rezept?.items || []);
  const validRule = total <= 6
    ? "1. Behandlung + 3 Monate"
    : "1. Behandlung + 6 Monate";
  const daysRemaining = diffDays(today, latestStart);

  return {
    mode: "normal",
    statusText: `Beginn bis ${formatDateDE(latestStart)}`,
    detailsText: `Gesamtmenge ${total}x · ${validRule}`,
    latestStartText: formatDateDE(latestStart),
    validUntilText: validRule,
    traffic: getTrafficLevel(daysRemaining),
    daysRemaining
  };
}
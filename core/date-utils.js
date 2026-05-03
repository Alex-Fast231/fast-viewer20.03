export function normalizeDeDateInput(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
  if (!digits) return "";
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
}

export function parseComparableDate(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() != year || (date.getMonth() + 1) != month || date.getDate() != day) {
    return null;
  }
  return date;
}

export function getComparableFromDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function parseDeDate(value) {
  const s = normalizeDeDateInput(value).trim();
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const comparable = `${m[3]}-${m[2]}-${m[1]}`;
  return parseComparableDate(comparable) ? comparable : null;
}

export function formatDeDate(value) {
  if (value instanceof Date) {
    return getComparableFromDate(value) ? formatDeDate(getComparableFromDate(value)) : "";
  }

  const comparable = parseComparableDate(value) ? String(value || "").trim() : parseDeDate(value);
  const date = parseComparableDate(comparable);
  if (!date) return "";

  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return `${dd}.${mm}.${yyyy}`;
}

export function compareDeDates(a, b) {
  const left = parseDeDate(a);
  const right = parseDeDate(b);
  if (left && right) return left.localeCompare(right, "de");
  if (left) return 1;
  if (right) return -1;
  return 0;
}

export function isDateInRange(dateValue, fromDate, toDate) {
  const current = parseDeDate(dateValue);
  const from = parseDeDate(fromDate);
  const to = parseDeDate(toDate);
  if (!current) return false;
  if (from && current < from) return false;
  if (to && current > to) return false;
  return true;
}

export function listComparableDatesInRange(fromDate, toDate) {
  const from = parseDeDate(fromDate);
  const to = parseDeDate(toDate);
  const start = parseComparableDate(from);
  const end = parseComparableDate(to);
  if (!start || !end || start > end) return [];

  const rows = [];
  const cursor = new Date(start.getTime());
  while (cursor <= end) {
    rows.push(getComparableFromDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return rows;
}
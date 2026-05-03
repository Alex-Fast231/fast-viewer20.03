export function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function getRezeptAusstellungsdatum(rezept) {
  const source = rezept && typeof rezept === "object" ? rezept : {};
  return String(
    source.ausstell
    || source.ausstellungsdatum
    || source.issueDate
    || source.datum
    || source.verordnungsdatum
    || ""
  ).trim();
}
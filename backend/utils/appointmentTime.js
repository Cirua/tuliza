// Normalize therapist type input used by appointment routes.
function normalizeTherapistType(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()

  if (normalized === 'mentor') return 'mentor'
  if (normalized === 'psychiatrist' || normalized === 'psychologist') return 'psychiatrist'
  return null
}

// Convert any date-like input to UTC midnight for range calculations.
function toUtcDateFloor(dateInput) {
  const date = new Date(dateInput)
  if (Number.isNaN(date.getTime())) return null
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0))
}

// Convert a date-like value to ISO string safely.
function toIsoString(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

// Validate that a slot is on a working day and within allowed hours.
function isWithinWorkingHours(startAt, endAt) {
  const start = new Date(startAt)
  const end = new Date(endAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false
  if (end <= start) return false

  const startDay = start.getDay()
  const endDay = end.getDay()
  if (startDay !== endDay) return false
  if (startDay === 0) return false

  const startMinutes = (start.getHours() * 60) + start.getMinutes()
  const endMinutes = (end.getHours() * 60) + end.getMinutes()

  if (startDay === 6) {
    return startMinutes >= 10 * 60 && endMinutes <= 14 * 60
  }

  return startMinutes >= 9 * 60 && endMinutes <= 17 * 60
}

// Return working hours window for a given day of week.
function getWorkingWindowByDay(dayOfWeek) {
  if (dayOfWeek === 0) return null
  if (dayOfWeek === 6) return { startHour: 10, endHour: 14 }
  return { startHour: 9, endHour: 17 }
}

module.exports = {
  normalizeTherapistType,
  toUtcDateFloor,
  toIsoString,
  isWithinWorkingHours,
  getWorkingWindowByDay,
}

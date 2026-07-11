// Enforce the minimum password complexity policy.
function isStrongPassword(password) {
  // At least 7 chars, uppercase, lowercase, and special char.
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{7,}$/.test(String(password || ''))
}

// Parse an integer and accept only positive values.
function parsePositiveInt(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}

// Parse phone input into a digit string or null when missing/invalid.
function parseNullablePhone(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return null

  const digits = raw.replace(/\D+/g, '')
  if (!digits) return null
  if (!/^\d+$/.test(digits)) return null
  if (/^0+$/.test(digits)) return null
  return digits
}

// Parse an integer and accept zero or positive values.
function parseNonNegativeInt(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) return null
  return parsed
}

module.exports = {
  isStrongPassword,
  parsePositiveInt,
  parseNullablePhone,
  parseNonNegativeInt,
}

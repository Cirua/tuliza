// Generate a compact, unique username seed for newly created students.
function buildStudentUsername(email) {
  const localPart = String(email || '').split('@')[0] || 'student'
  const base = localPart.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'student'
  const suffix = Date.now().toString().slice(-6)
  return `${base}_${suffix}`
}

module.exports = { buildStudentUsername }


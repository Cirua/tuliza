// Map role names to their primary key column in role profile tables.
function roleIdColumn(role) {
  if (role === 'student') return 'student_id'
  if (role === 'mentor') return 'mentor_id'
  if (role === 'psychiatrist') return 'psychiatrist_id'
  if (role === 'admin') return 'admin_id'
  return null
}

// Resolve the dashboard page path for each authenticated role.
function dashboardPath(role) {
  if (role === 'student') return 'student.html'
  if (role === 'mentor') return 'mentor.html'
  if (role === 'psychiatrist') return 'psychologist.html'
  if (role === 'admin') return 'admin.html'
  return 'account.html'
}

// Resolve the profile page path for each role.
function profilePath(role) {
  if (role === 'student') return 'profile-student.html'
  if (role === 'mentor') return 'profile-mentor.html'
  if (role === 'psychiatrist') return 'profile-psychiatrist.html'
  if (role === 'admin') return 'admin.html'
  return 'account.html'
}

module.exports = {
  roleIdColumn,
  dashboardPath,
  profilePath,
}

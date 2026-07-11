function setupAuthRoutes(app, dbPool, {
  bcrypt,
  sanitizeRole,
  roleToTable,
  resolveRoleRow,
  resolveOrRepairRoleProfileRow,
  createSessionToken,
  profilePath,
  dashboardPath,
  buildStudentUsername,
  ensurePasswordHashColumn,
  ensureRoleProfileRow,
  resolveStudentIdForQuestionnaire,
  ensureQuestionnaireWriteSchema,
  isStrongPassword,
  parseNullablePhone,
  ensureJournalSchema,
  ensureMentorWorkspaceSchema,
  ensurePsychiatristWorkspaceSchema,
  resolvePsychiatristTableMeta,
  tableExists,
  tableHasColumn,
  ensureStudentIdAutoIncrement,
  ensureMentorIdAutoIncrement,
  ensurePsychiatristIdAutoIncrement,
  parsePositiveInt,
  toIsoString,
  resolveMentorWorkspaceId,
  resolvePsychiatristWorkspaceId,
} = {}) {
  // Student-only signup endpoint using credentials in signup table.
  app.post('/api/signup', async (req, res) => {
    try {
      const { email, password } = req.body || {}
      const normalizedRole = 'student'

      if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email is required' })
      if (!password || typeof password !== 'string') return res.status(400).json({ error: 'Password is required' })
      if (!isStrongPassword(password)) {
        return res.status(400).json({
          error: 'Password must be more than 6 characters and include uppercase, lowercase, and a special character.',
        })
      }

      const table = roleToTable(normalizedRole)
      if (!table) return res.status(400).json({ error: 'Invalid role' })

      const roleRow = await resolveRoleRow(dbPool, normalizedRole)
      if (!roleRow) return res.status(400).json({ error: 'Role mapping missing in roles table.' })

      // role-specific password_hash column
      if (ensurePasswordHashColumn) await ensurePasswordHashColumn(dbPool, table)

      const existingSignup = await dbPool.query('SELECT signup_id FROM signup WHERE LOWER(email) = LOWER($1) LIMIT 1', [email])
      if (existingSignup.rows[0]) return res.status(409).json({ error: 'Email already exists. Please log in.' })

      const passwordHash = await bcrypt.hash(password, 10)
      const signupInsert = await dbPool.query(
        'INSERT INTO signup (email, role_id, role_name, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING signup_id',
        [email, Number(roleRow.role_id), String(roleRow.role_name), normalizedRole, passwordHash]
      )

      const signupId = Number(signupInsert.rows[0].signup_id)

      return res.json({
        ok: true,
        role: normalizedRole,
        signupId: String(signupId),
        userId: null,
        profileComplete: false,
        redirectTo: profilePath(normalizedRole),
        message: 'Signup successful.',
      })
    } catch (err) {
      if (err && err.code === '23505') {
        return res.status(409).json({ error: 'Email already exists. Please log in.' })
      }
      console.error('Signup failed:', err.message)
      return res.status(500).json({ error: 'Signup failed' })
    }
  })

  // Role-resolving login endpoint with session token issuance.
  app.post('/api/login', async (req, res) => {
    try {
      const { email, password } = req.body || {}

      if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email is required' })
      if (!password || typeof password !== 'string') return res.status(400).json({ error: 'Password is required' })

      const signupResult = await dbPool.query(
        'SELECT signup_id, role, role_name, password_hash FROM signup WHERE LOWER(email) = LOWER($1)',
        [email]
      )
      if (!signupResult.rows[0]) return res.status(401).json({ error: 'Invalid email or password' })

      let matchedSignup = null
      for (const row of signupResult.rows) {
        const storedPasswordHash = String(row.password_hash || '')
        if (!storedPasswordHash) continue
        const ok = await bcrypt.compare(password, storedPasswordHash)
        if (ok) {
          matchedSignup = row
          break
        }
      }

      if (!matchedSignup) return res.status(401).json({ error: 'Invalid email or password' })

      const normalizedRole = sanitizeRole(matchedSignup.role || matchedSignup.role_name)
      if (!normalizedRole) return res.status(401).json({ error: 'Invalid email or password' })

      const table = roleToTable(normalizedRole)
      const userIdCol = table && (normalizedRole === 'student'
        ? 'student_id'
        : normalizedRole === 'mentor'
          ? 'mentor_id'
          : normalizedRole === 'psychiatrist'
            ? 'psychiatrist_id'
            : null)

      const signupId = Number(matchedSignup.signup_id)

      // Use existing orchestrator logic via helper signature
      const userId = await resolveOrRepairRoleProfileRow(dbPool, {
        role: normalizedRole,
        table,
        userIdCol,
        signupId: Number(signupId),
        email,
      })

      if (!userId) {
        const sessionToken = createSessionToken({ userId: String(signupId), role: normalizedRole })
        return res.json({
          ok: true,
          role: normalizedRole,
          userId: null,
          signupId: String(signupId),
          profileComplete: false,
          needsQuestionnaire: normalizedRole === 'student',
          redirectTo: profilePath(normalizedRole),
          sessionToken,
        })
      }

      let needsQuestionnaire = false
      if (normalizedRole === 'student') {
        const q = await dbPool.query('SELECT questionnaire_id FROM questionnaire WHERE student_id = $1 LIMIT 1', [Number(userId)])
        needsQuestionnaire = !q.rows[0]
      }

      const redirectTo = normalizedRole === 'student' && needsQuestionnaire ? 'questionnaire.html' : dashboardPath(normalizedRole)
      const sessionToken = createSessionToken({ userId, role: normalizedRole })

      return res.json({
        ok: true,
        role: normalizedRole,
        userId,
        signupId: String(signupId),
        profileComplete: true,
        needsQuestionnaire,
        redirectTo,
        sessionToken,
      })
    } catch (err) {
      console.error('Login failed:', err.message)
      return res.status(500).json({ error: 'Login failed' })
    }
  })
}

module.exports = { setupAuthRoutes }


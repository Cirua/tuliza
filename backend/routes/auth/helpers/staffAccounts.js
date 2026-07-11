async function createStaffAccount({
  dbPool,
  bcrypt,
  sanitizeRole,
  isStrongPassword,
  resolveRoleRow,
  roleToTable,
  roleIdColumn,
  ensurePasswordHashColumn,
  ensureRoleProfileRow,
  body,
}) {
  const { role, email, password, fullName } = body || {}
  const normalizedRole = sanitizeRole(role)

  if (normalizedRole !== 'mentor' && normalizedRole !== 'psychiatrist') {
    return { ok: false, status: 400, error: 'Role must be mentor or psychiatrist.' }
  }

  const safeEmail = String(email || '').trim().toLowerCase()
  const safeFullName = String(fullName || '').trim()

  if (!safeEmail) return { ok: false, status: 400, error: 'Email is required.' }
  if (!safeFullName) return { ok: false, status: 400, error: 'Full name is required.' }
  if (!password || typeof password !== 'string') return { ok: false, status: 400, error: 'Password is required.' }
  if (!isStrongPassword(password)) {
    return {
      ok: false,
      status: 400,
      error: 'Password must be more than 6 characters and include uppercase, lowercase, and a special character.',
    }
  }

  const roleRow = await resolveRoleRow(dbPool, normalizedRole)
  if (!roleRow) return { ok: false, status: 400, error: 'Role mapping missing in roles table.' }

  const table = roleToTable(normalizedRole)
  const userIdCol = roleIdColumn(normalizedRole)
  if (!table || !userIdCol) return { ok: false, status: 400, error: 'Invalid role.' }

  await ensurePasswordHashColumn(dbPool, table)

  const existingSignup = await dbPool.query('SELECT signup_id FROM signup WHERE LOWER(email) = LOWER($1) LIMIT 1', [safeEmail])
  if (existingSignup.rows[0]) {
    return { ok: false, status: 409, error: 'Email already exists. Use a different email.' }
  }

  const passwordHash = await bcrypt.hash(password, 10)
  const signupInsert = await dbPool.query(
    'INSERT INTO signup (email, role_id, role_name, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING signup_id',
    [safeEmail, Number(roleRow.role_id), String(roleRow.role_name), normalizedRole, passwordHash]
  )

  const signupId = Number(signupInsert.rows[0].signup_id)
  const userId = await ensureRoleProfileRow(dbPool, {
    role: normalizedRole,
    table,
    userIdCol,
    signupId,
    email: safeEmail,
    fullName: safeFullName,
    passwordHash,
  })

  return {
    ok: true,
    payload: {
      signupId: String(signupId),
      userId: userId == null ? null : String(userId),
      role: normalizedRole,
    },
  }
}

async function updateStaffAccountBySignupId({
  dbPool,
  bcrypt,
  sanitizeRole,
  isStrongPassword,
  resolvePsychiatristTableMeta,
  signupId,
  body,
}) {
  if (!Number.isInteger(signupId) || signupId <= 0) {
    return { ok: false, status: 400, error: 'Valid signupId is required.' }
  }

  const { email, password, fullName } = body || {}
  const safeEmail = String(email || '').trim().toLowerCase()
  const safeFullName = String(fullName || '').trim()

  if (!safeEmail) return { ok: false, status: 400, error: 'Email is required.' }

  const signupRow = await dbPool.query('SELECT signup_id, role, role_name FROM signup WHERE signup_id = $1 LIMIT 1', [signupId])
  if (!signupRow.rows[0]) {
    return { ok: false, status: 404, error: 'User account not found.' }
  }

  const normalizedRole = sanitizeRole(signupRow.rows[0].role || signupRow.rows[0].role_name)
  if (normalizedRole !== 'mentor' && normalizedRole !== 'psychiatrist') {
    return { ok: false, status: 400, error: 'Only mentor and psychiatrist accounts can be edited here.' }
  }

  const duplicateSignup = await dbPool.query(
    'SELECT signup_id FROM signup WHERE LOWER(email) = LOWER($1) AND signup_id <> $2 LIMIT 1',
    [safeEmail, signupId]
  )
  if (duplicateSignup.rows[0]) {
    return { ok: false, status: 409, error: 'Email already exists. Use a different email.' }
  }

  if (password != null && String(password).trim()) {
    if (!isStrongPassword(password)) {
      return {
        ok: false,
        status: 400,
        error: 'Password must be more than 6 characters and include uppercase, lowercase, and a special character.',
      }
    }

    const passwordHash = await bcrypt.hash(String(password), 10)
    await dbPool.query('UPDATE signup SET email = $1, password_hash = $2 WHERE signup_id = $3', [safeEmail, passwordHash, signupId])
  } else {
    await dbPool.query('UPDATE signup SET email = $1 WHERE signup_id = $2', [safeEmail, signupId])
  }

  if (normalizedRole === 'mentor') {
    await dbPool.query('UPDATE mentor SET email = $1, full_name = COALESCE($2, full_name) WHERE signup_id = $3', [
      safeEmail,
      safeFullName || null,
      signupId,
    ])
  } else {
    const psychiatristMeta = await resolvePsychiatristTableMeta(dbPool)
    if (!psychiatristMeta) {
      return { ok: false, status: 500, error: 'Psychiatrist table metadata is unavailable.' }
    }

    await dbPool.query(
      `UPDATE ${psychiatristMeta.table} SET email = $1, full_name = COALESCE($2, full_name) WHERE signup_id = $3`,
      [safeEmail, safeFullName || null, signupId]
    )
  }

  return { ok: true }
}

async function deleteStaffAccountBySignupId({ dbPool, sanitizeRole, resolvePsychiatristTableMeta, signupId }) {
  const client = await dbPool.connect()
  try {
    await client.query('BEGIN')

    const signupRow = await client.query('SELECT role, role_name FROM signup WHERE signup_id = $1 LIMIT 1', [signupId])
    if (!signupRow.rows[0]) {
      await client.query('ROLLBACK')
      return { ok: false, status: 404, error: 'User account not found.' }
    }

    const normalizedRole = sanitizeRole(signupRow.rows[0].role || signupRow.rows[0].role_name)
    if (normalizedRole !== 'mentor' && normalizedRole !== 'psychiatrist') {
      await client.query('ROLLBACK')
      return { ok: false, status: 400, error: 'Only mentor and psychiatrist accounts can be deleted here.' }
    }

    if (normalizedRole === 'mentor') {
      await client.query('DELETE FROM mentor WHERE signup_id = $1', [signupId])
    } else {
      const psychiatristMeta = await resolvePsychiatristTableMeta(client)
      if (!psychiatristMeta) {
        await client.query('ROLLBACK')
        return { ok: false, status: 500, error: 'Psychiatrist table metadata is unavailable.' }
      }

      await client.query(`DELETE FROM ${psychiatristMeta.table} WHERE signup_id = $1`, [signupId])
    }

    await client.query('DELETE FROM signup WHERE signup_id = $1', [signupId])
    await client.query('COMMIT')

    return { ok: true }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (_) {}
    throw err
  } finally {
    client.release()
  }
}

module.exports = {
  createStaffAccount,
  updateStaffAccountBySignupId,
  deleteStaffAccountBySignupId,
}

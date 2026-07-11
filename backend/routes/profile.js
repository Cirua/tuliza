const { verifySessionToken } = require('../auth/sessionToken')

function setupProfileRoutes({
  app,
  dbPool,
  sanitizeRole,
  buildStudentUsername,
  parseNullablePhone,
  ensureStudentIdAutoIncrement,
  ensureMentorIdAutoIncrement,
  ensurePsychiatristIdAutoIncrement,
  syncLegacyStudentTableIfPresent,
  dashboardPath,
  createSessionToken,
  tableExists,
}) {
  app.post('/api/profile', async (req, res) => {
    try {
      const {
        signupId,
        role,
        fullName,
        username,
        studentId,
        gender,
        phoneNo,
        modeOfPayment,
        certification,
        licenceNumber,
        yearsOfExperience,
        billingDetails,
        bio,
        contactId,
        resourceId,
      } = req.body || {}
      const normalizedRole = sanitizeRole(role)
      const parsedSignupId = Number(signupId)

      if (!normalizedRole) return res.status(400).json({ error: 'Invalid role' })
      if (!Number.isInteger(parsedSignupId) || parsedSignupId <= 0) {
        return res.status(400).json({ error: 'Valid signupId is required' })
      }

      const signupRow = await dbPool.query(
        `
        SELECT signup_id, email, role, role_name, password_hash
        FROM signup
        WHERE signup_id = $1
        LIMIT 1
        `,
        [parsedSignupId]
      )
      if (!signupRow.rows[0]) return res.status(404).json({ error: 'Signup account not found' })

      const signup = signupRow.rows[0]
      const signupRole = sanitizeRole(signup.role || signup.role_name)
      if (signupRole !== normalizedRole) {
        return res.status(400).json({ error: 'Role does not match signup account' })
      }

      const email = String(signup.email || '')
      const passwordHash = String(signup.password_hash || '')
      const safeFullName = String(fullName || '').trim()

      if ((normalizedRole === 'student' || normalizedRole === 'mentor' || normalizedRole === 'psychiatrist') && !safeFullName) {
        return res.status(400).json({ error: 'Full name is required' })
      }

      let profileUserId = null
      if (normalizedRole === 'student') {
        await ensureStudentIdAutoIncrement(dbPool)

        const safeUsername = String(username || '').trim() || buildStudentUsername(email)
        const safeStudentIdentifier = String(studentId || '').trim() || null
        const safeGender = String(gender || '').trim() || null
        const safePhoneNo = parseNullablePhone(phoneNo)
        const safeModeOfPayment = String(modeOfPayment || '').trim() || null

        const studentUpsert = await dbPool.query(
          `
          INSERT INTO student (
            signup_id, full_name, email, username, password_hash, student_identifier, gender, phone_no, mode_of_payment
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (signup_id)
          DO UPDATE SET
            full_name = EXCLUDED.full_name,
            email = EXCLUDED.email,
            username = EXCLUDED.username,
            password_hash = EXCLUDED.password_hash,
            student_identifier = EXCLUDED.student_identifier,
            gender = EXCLUDED.gender,
            phone_no = EXCLUDED.phone_no,
            mode_of_payment = EXCLUDED.mode_of_payment
          RETURNING student_id
          `,
          [
            parsedSignupId,
            safeFullName,
            email,
            safeUsername,
            passwordHash,
            safeStudentIdentifier,
            safeGender,
            safePhoneNo,
            safeModeOfPayment,
          ]
        )

        profileUserId = String(studentUpsert.rows[0].student_id)
        await syncLegacyStudentTableIfPresent(dbPool, Number(profileUserId))
      } else if (normalizedRole === 'mentor' || normalizedRole === 'psychiatrist') {
        const safePhoneNo = parseNullablePhone(phoneNo)

        if (normalizedRole === 'mentor') {
          const safeBio = String(bio || '').trim() || null

          await ensureMentorIdAutoIncrement(dbPool)
          const mentorUpsert = await dbPool.query(
            `
            INSERT INTO mentor (signup_id, full_name, email, password_hash, phone_no, bio, student_id)
            VALUES ($1, $2, $3, $4, $5, $6, NULL)
            ON CONFLICT (signup_id)
            DO UPDATE SET
              full_name = EXCLUDED.full_name,
              email = EXCLUDED.email,
              password_hash = EXCLUDED.password_hash,
              phone_no = EXCLUDED.phone_no,
              bio = EXCLUDED.bio
            RETURNING mentor_id
            `,
            [parsedSignupId, safeFullName, email, passwordHash, safePhoneNo, safeBio]
          )

          profileUserId = String(mentorUpsert.rows[0].mentor_id)
        } else {
          const safeCertification = String(certification || '').trim() || null
          const safeLicenceNumber = String(licenceNumber || '').trim() || null
          const yearsValue = Number(yearsOfExperience)
          const safeYearsOfExperience =
            yearsOfExperience == null || String(yearsOfExperience).trim() === ''
              ? null
              : Number.isInteger(yearsValue) && yearsValue >= 0
                ? yearsValue
                : null
          const safeBillingDetails = String(billingDetails || '').trim() || null

          await ensurePsychiatristIdAutoIncrement(dbPool)
          const psychiatristUpsert = await dbPool.query(
            `
            INSERT INTO psychiatrist (
              signup_id,
              full_name,
              email,
              password_hash,
              phone_no,
              certification,
              licence_number,
              years_of_experience,
              billing_details,
              student_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
            ON CONFLICT (signup_id)
            DO UPDATE SET
              full_name = EXCLUDED.full_name,
              email = EXCLUDED.email,
              password_hash = EXCLUDED.password_hash,
              phone_no = EXCLUDED.phone_no,
              certification = EXCLUDED.certification,
              licence_number = EXCLUDED.licence_number,
              years_of_experience = EXCLUDED.years_of_experience,
              billing_details = EXCLUDED.billing_details
            RETURNING psychiatrist_id
            `,
            [
              parsedSignupId,
              safeFullName,
              email,
              passwordHash,
              safePhoneNo,
              safeCertification,
              safeLicenceNumber,
              safeYearsOfExperience,
              safeBillingDetails,
            ]
          )

          profileUserId = String(psychiatristUpsert.rows[0].psychiatrist_id)
        }
      } else if (normalizedRole === 'admin') {
        const safeContactId = contactId == null || String(contactId).trim() === '' ? null : Number(contactId)
        const safeResourceId = resourceId == null || String(resourceId).trim() === '' ? null : Number(resourceId)

        const adminExisting = await dbPool.query('SELECT admin_id FROM admins WHERE signup_id = $1 LIMIT 1', [parsedSignupId])

        if (adminExisting.rows[0]) {
          const updated = await dbPool.query(
            `
            UPDATE admins
            SET password_hash = $1,
                contact_id = $2,
                resource_id = $3
            WHERE signup_id = $4
            RETURNING admin_id
            `,
            [passwordHash, safeContactId, safeResourceId, parsedSignupId]
          )
          profileUserId = String(updated.rows[0].admin_id)
        } else {
          const created = await dbPool.query(
            `
            INSERT INTO admins (password_hash, contact_id, resource_id, signup_id)
            VALUES ($1, $2, $3, $4)
            RETURNING admin_id
            `,
            [passwordHash, safeContactId, safeResourceId, parsedSignupId]
          )
          profileUserId = String(created.rows[0].admin_id)
        }
      }

      if (!profileUserId) return res.status(500).json({ error: 'Failed to create profile' })

      let redirectTo = dashboardPath(normalizedRole)
      let needsQuestionnaire = false
      if (normalizedRole === 'student') {
        const q = await dbPool.query('SELECT questionnaire_id FROM questionnaire WHERE student_id = $1 LIMIT 1', [Number(profileUserId)])
        needsQuestionnaire = !q.rows[0]
        redirectTo = needsQuestionnaire ? 'questionnaire.html' : 'student.html'
      }

      const sessionToken = createSessionToken({ userId: profileUserId, role: normalizedRole })

      return res.json({
        ok: true,
        role: normalizedRole,
        signupId: String(parsedSignupId),
        userId: profileUserId,
        sessionToken,
        profileComplete: true,
        needsQuestionnaire,
        redirectTo,
      })
    } catch (err) {
      console.error('Profile save failed:', err.message)
      return res.status(500).json({ error: 'Failed to save profile' })
    }
  })

  app.get('/api/profile', async (req, res) => {
    try {
      const normalizedRole = sanitizeRole(req.query.role)
      const parsedSignupId = Number(req.query.signupId)

      if (!normalizedRole) return res.status(400).json({ error: 'Invalid role' })
      if (!Number.isInteger(parsedSignupId) || parsedSignupId <= 0) {
        return res.status(400).json({ error: 'Valid signupId is required' })
      }

      const signupRow = await dbPool.query(
        `
        SELECT signup_id, role, role_name
        FROM signup
        WHERE signup_id = $1
        LIMIT 1
        `,
        [parsedSignupId]
      )

      if (!signupRow.rows[0]) return res.status(404).json({ error: 'Signup account not found' })

      const signupRole = sanitizeRole(signupRow.rows[0].role || signupRow.rows[0].role_name)
      if (signupRole !== normalizedRole) {
        return res.status(400).json({ error: 'Role does not match signup account' })
      }

      if (normalizedRole === 'student') {
        const result = await dbPool.query(
          `
          SELECT
            student_id,
            full_name,
            username,
            student_identifier,
            gender,
            phone_no,
            mode_of_payment
          FROM student
          WHERE signup_id = $1
          LIMIT 1
          `,
          [parsedSignupId]
        )

        if (!result.rows[0]) {
          return res.json({ ok: true, role: normalizedRole, signupId: String(parsedSignupId), exists: false, profile: {} })
        }

        const row = result.rows[0]
        return res.json({
          ok: true,
          role: normalizedRole,
          signupId: String(parsedSignupId),
          userId: String(row.student_id),
          exists: true,
          profile: {
            fullName: row.full_name || '',
            username: row.username || '',
            studentId: row.student_identifier || '',
            gender: row.gender || '',
            phoneNo: row.phone_no == null ? '' : String(row.phone_no),
            modeOfPayment: row.mode_of_payment || '',
          },
        })
      }

      if (normalizedRole === 'mentor') {
        const result = await dbPool.query(
          `
          SELECT mentor_id, full_name, phone_no, bio
          FROM mentor
          WHERE signup_id = $1
          LIMIT 1
          `,
          [parsedSignupId]
        )

        if (!result.rows[0]) {
          return res.json({ ok: true, role: normalizedRole, signupId: String(parsedSignupId), exists: false, profile: {} })
        }

        const row = result.rows[0]
        return res.json({
          ok: true,
          role: normalizedRole,
          signupId: String(parsedSignupId),
          userId: String(row.mentor_id),
          exists: true,
          profile: {
            fullName: row.full_name || '',
            phoneNo: row.phone_no == null ? '' : String(row.phone_no),
            bio: row.bio || '',
          },
        })
      }

      if (normalizedRole === 'psychiatrist') {
        const result = await dbPool.query(
          `
          SELECT
            psychiatrist_id,
            full_name,
            phone_no,
            certification,
            licence_number,
            years_of_experience,
            billing_details
          FROM psychiatrist
          WHERE signup_id = $1
          LIMIT 1
          `,
          [parsedSignupId]
        )

        if (!result.rows[0]) {
          return res.json({ ok: true, role: normalizedRole, signupId: String(parsedSignupId), exists: false, profile: {} })
        }

        const row = result.rows[0]
        return res.json({
          ok: true,
          role: normalizedRole,
          signupId: String(parsedSignupId),
          userId: String(row.psychiatrist_id),
          exists: true,
          profile: {
            fullName: row.full_name || '',
            phoneNo: row.phone_no == null ? '' : String(row.phone_no),
            certification: row.certification || '',
            licenceNumber: row.licence_number == null ? '' : String(row.licence_number),
            yearsOfExperience: row.years_of_experience == null ? '' : String(row.years_of_experience),
            billingDetails: row.billing_details || '',
          },
        })
      }

      if (normalizedRole === 'admin') {
        const result = await dbPool.query(
          `
          SELECT admin_id, contact_id, resource_id
          FROM admins
          WHERE signup_id = $1
          LIMIT 1
          `,
          [parsedSignupId]
        )

        if (!result.rows[0]) {
          return res.json({ ok: true, role: normalizedRole, signupId: String(parsedSignupId), exists: false, profile: {} })
        }

        const row = result.rows[0]
        return res.json({
          ok: true,
          role: normalizedRole,
          signupId: String(parsedSignupId),
          userId: String(row.admin_id),
          exists: true,
          profile: {
            contactId: row.contact_id == null ? '' : String(row.contact_id),
            resourceId: row.resource_id == null ? '' : String(row.resource_id),
          },
        })
      }

      return res.status(400).json({ error: 'Role not supported for profile lookup' })
    } catch (err) {
      console.error('Profile fetch failed:', err.message)
      return res.status(500).json({ error: 'Failed to load profile' })
    }
  })

  app.delete('/api/profile', async (req, res) => {
    const normalizedRole = sanitizeRole(req.body?.role)
    const parsedSignupId = Number(req.body?.signupId)

    if (!normalizedRole) return res.status(400).json({ error: 'Invalid role' })
    if (!Number.isInteger(parsedSignupId) || parsedSignupId <= 0) {
      return res.status(400).json({ error: 'Valid signupId is required' })
    }

    const authHeader = String(req.headers.authorization || '').trim()
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : ''
    const token =
      bearerToken ||
      String(req.headers['x-session-token'] || '').trim() ||
      String(req.body?.sessionToken || '').trim() ||
      String(req.query?.sessionToken || '').trim()

    const sessionClaims = verifySessionToken(token)
    if (!sessionClaims) {
      return res.status(401).json({ error: 'Authentication is required.' })
    }

    const sessionRole = sanitizeRole(sessionClaims.role)
    if (sessionRole !== 'admin' && sessionRole !== normalizedRole) {
      return res.status(403).json({ error: 'You are not allowed to delete this profile.' })
    }

    const client = await dbPool.connect()
    try {
      await client.query('BEGIN')

      const signupRow = await client.query(
        `
        SELECT signup_id, role, role_name
        FROM signup
        WHERE signup_id = $1
        LIMIT 1
        `,
        [parsedSignupId]
      )
      if (!signupRow.rows[0]) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Signup account not found' })
      }

      const signupRole = sanitizeRole(signupRow.rows[0].role || signupRow.rows[0].role_name)
      if (signupRole !== normalizedRole) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Role does not match signup account' })
      }

      if (sessionRole !== 'admin') {
        const tokenUserId = Number(sessionClaims.userId)
        let isOwner = Number.isInteger(tokenUserId) && tokenUserId > 0 && tokenUserId === parsedSignupId

        if (!isOwner && Number.isInteger(tokenUserId) && tokenUserId > 0) {
          const profileTable =
            normalizedRole === 'student'
              ? { table: 'student', idColumn: 'student_id' }
              : normalizedRole === 'mentor'
                ? { table: 'mentor', idColumn: 'mentor_id' }
                : normalizedRole === 'psychiatrist'
                  ? { table: 'psychiatrist', idColumn: 'psychiatrist_id' }
                  : null

          if (profileTable) {
            const ownershipRow = await client.query(
              `SELECT ${profileTable.idColumn} FROM ${profileTable.table} WHERE signup_id = $1 AND ${profileTable.idColumn} = $2 LIMIT 1`,
              [parsedSignupId, tokenUserId]
            )
            isOwner = Boolean(ownershipRow.rows[0])
          }
        }

        if (!isOwner) {
          await client.query('ROLLBACK')
          return res.status(403).json({ error: 'You are not allowed to delete this profile.' })
        }
      }

      const hasMessages = await tableExists(client, 'messages')
      const hasAssignments = await tableExists(client, 'assignments')
      const hasQuestionnaire = await tableExists(client, 'questionnaire')
      const hasAppointments = await tableExists(client, 'appointments')
      const hasAvailability = await tableExists(client, 'therapist_availability')
      const hasJournal = await tableExists(client, 'journal')

      if (normalizedRole === 'student') {
        const studentRow = await client.query('SELECT student_id FROM student WHERE signup_id = $1 LIMIT 1', [parsedSignupId])
        if (studentRow.rows[0]) {
          const studentId = Number(studentRow.rows[0].student_id)
          if (hasMessages) {
            await client.query('DELETE FROM messages WHERE student_id = $1', [studentId])
          }
          if (hasAssignments) {
            await client.query('DELETE FROM assignments WHERE student_id = $1', [studentId])
          }
          if (hasJournal) {
            await client.query('DELETE FROM journal WHERE student_id = $1', [studentId])
          }
          if (hasAppointments) {
            await client.query('DELETE FROM appointments WHERE student_id = $1', [studentId])
          }
          await client.query('DELETE FROM student WHERE student_id = $1', [studentId])
        }
      }

      if (normalizedRole === 'mentor') {
        const mentorRow = await client.query('SELECT mentor_id FROM mentor WHERE signup_id = $1 LIMIT 1', [parsedSignupId])
        if (mentorRow.rows[0]) {
          const mentorId = Number(mentorRow.rows[0].mentor_id)
          if (hasMessages) {
            await client.query('DELETE FROM messages WHERE mentor_id = $1', [mentorId])
          }
          if (hasAssignments) {
            await client.query('UPDATE assignments SET mentor_id = NULL WHERE mentor_id = $1', [mentorId])
          }
          if (hasQuestionnaire) {
            await client.query('UPDATE questionnaire SET mentor_id = NULL WHERE mentor_id = $1', [mentorId])
          }
          if (hasAppointments) {
            await client.query("DELETE FROM appointments WHERE therapist_type = 'mentor' AND therapist_id = $1", [mentorId])
          }
          if (hasAvailability) {
            await client.query("DELETE FROM therapist_availability WHERE therapist_type = 'mentor' AND therapist_id = $1", [mentorId])
          }
          await client.query('DELETE FROM mentor WHERE mentor_id = $1', [mentorId])
        }
      }

      if (normalizedRole === 'psychiatrist') {
        const psychiatristRow = await client.query('SELECT psychiatrist_id FROM psychiatrist WHERE signup_id = $1 LIMIT 1', [parsedSignupId])
        if (psychiatristRow.rows[0]) {
          const psychiatristId = Number(psychiatristRow.rows[0].psychiatrist_id)
          if (hasMessages) {
            await client.query('DELETE FROM messages WHERE psychiatrist_id = $1', [psychiatristId])
          }
          if (hasAssignments) {
            await client.query('UPDATE assignments SET psychiatrist_id = NULL WHERE psychiatrist_id = $1', [psychiatristId])
          }
          if (hasQuestionnaire) {
            await client.query('UPDATE questionnaire SET psychiatrist_id = NULL WHERE psychiatrist_id = $1', [psychiatristId])
          }
          if (hasAppointments) {
            await client.query("DELETE FROM appointments WHERE therapist_type = 'psychiatrist' AND therapist_id = $1", [psychiatristId])
          }
          if (hasAvailability) {
            await client.query("DELETE FROM therapist_availability WHERE therapist_type = 'psychiatrist' AND therapist_id = $1", [psychiatristId])
          }
          await client.query('DELETE FROM psychiatrist WHERE psychiatrist_id = $1', [psychiatristId])
        }
      }

      if (normalizedRole === 'admin') {
        await client.query('DELETE FROM admins WHERE signup_id = $1', [parsedSignupId])
      }

      await client.query('DELETE FROM signup WHERE signup_id = $1', [parsedSignupId])
      await client.query('COMMIT')

      return res.json({ ok: true, message: 'Profile deleted successfully.' })
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch (_) {}
      console.error('Profile delete failed:', err.message)
      return res.status(500).json({ error: 'Failed to delete profile' })
    } finally {
      client.release()
    }
  })
}

module.exports = { setupProfileRoutes }

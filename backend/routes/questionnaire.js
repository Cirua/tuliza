function setupQuestionnaireRoutes({
  app,
  dbPool,
  sanitizeRole,
  ensureQuestionnaireWriteSchema,
  resolveStudentIdForQuestionnaire,
  syncLegacyStudentTableIfPresent,
  computeAssignmentDecision,
  findLeastLoadedAssignee,
  resolveQuestionnaireAssigneeId,
}) {
  app.post('/api/questionnaire', async (req, res) => {
    try {
      const { studentId, answers } = req.body || {}
      const parsedStudentId = Number(studentId)
      if (!Number.isInteger(parsedStudentId) || parsedStudentId <= 0) {
        return res.status(400).json({ error: 'Valid studentId is required' })
      }
      if (!answers || typeof answers !== 'object') {
        return res.status(400).json({ error: 'Questionnaire answers are required' })
      }

      await ensureQuestionnaireWriteSchema(dbPool)

      const requiredFields = [
        'mentalHealthSupport',
        'concerns',
        'period_affected',
        'support_type',
        'support_preferences',
        'religion',
        'religion_type',
        'spiritual_status',
        'therapy_status',
        'seek_support',
        'expectations',
        'session_structure',
        'communication',
      ]

      const missingField = requiredFields.find((field) => !String(answers[field] || '').trim())
      if (missingField) {
        return res.status(400).json({ error: `Missing questionnaire field: ${missingField}` })
      }

      const resolvedStudentId = await resolveStudentIdForQuestionnaire(dbPool, parsedStudentId)
      if (!resolvedStudentId) {
        return res.status(400).json({ error: 'Could not resolve student profile for questionnaire submission' })
      }

      await syncLegacyStudentTableIfPresent(dbPool, resolvedStudentId)

      const studentResult = await dbPool.query('SELECT username FROM student WHERE student_id = $1 LIMIT 1', [resolvedStudentId])
      if (!studentResult.rows[0]) {
        return res.status(404).json({ error: 'Student profile not found' })
      }

      const decision = computeAssignmentDecision(answers)
      const assigneeRole = decision.assignedRole

      const existingAssignment = await dbPool.query(
        `
        SELECT mentor_id, psychiatrist_id
        FROM assignments
        WHERE student_id = $1
        LIMIT 1
        `,
        [resolvedStudentId]
      )

      const existing = existingAssignment.rows[0] || {}
      const existingAssigneeId =
        assigneeRole === 'mentor'
          ? (existing.mentor_id != null ? Number(existing.mentor_id) : null)
          : assigneeRole === 'psychiatrist'
            ? (existing.psychiatrist_id != null ? Number(existing.psychiatrist_id) : null)
            : null

      const assigneeId = assigneeRole
        ? (existingAssigneeId != null ? existingAssigneeId : await findLeastLoadedAssignee(dbPool, assigneeRole))
        : null

      if (assigneeRole && assigneeId == null) {
        return res.status(409).json({
          error: 'No available support staff could be assigned right now. Please try again shortly.',
        })
      }

      const mentorId =
        assigneeRole === 'mentor' && assigneeId != null
          ? await resolveQuestionnaireAssigneeId(dbPool, 'mentor', assigneeId)
          : null
      const psychiatristId =
        assigneeRole === 'psychiatrist' && assigneeId != null
          ? await resolveQuestionnaireAssigneeId(dbPool, 'psychiatrist', assigneeId)
          : null

      const legacyAnswersJsonCheck = await dbPool.query(
        `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'questionnaire'
            AND column_name = 'answers_json'
        ) AS exists
        `
      )
      const hasLegacyAnswersJson = Boolean(legacyAnswersJsonCheck.rows[0] && legacyAnswersJsonCheck.rows[0].exists)

      const legacyUpdatedAtCheck = await dbPool.query(
        `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'questionnaire'
            AND column_name = 'updated_at'
        ) AS exists
        `
      )
      const hasLegacyUpdatedAt = Boolean(legacyUpdatedAtCheck.rows[0] && legacyUpdatedAtCheck.rows[0].exists)

      const legacySupportPreferenceCheck = await dbPool.query(
        `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'questionnaire'
            AND column_name = 'support_preference'
        ) AS exists
        `
      )
      const hasLegacySupportPreference = Boolean(
        legacySupportPreferenceCheck.rows[0] && legacySupportPreferenceCheck.rows[0].exists
      )

      const structuredValues = [
        resolvedStudentId,
        String(answers.mentalHealthSupport),
        String(answers.concerns),
        String(answers.period_affected),
        String(answers.support_type),
        String(answers.support_preferences),
        String(answers.religion),
        String(answers.religion_type),
        String(answers.spiritual_status),
        String(answers.therapy_status),
        String(answers.seek_support),
        String(answers.expectations),
        String(answers.session_structure),
        String(answers.communication),
        mentorId,
        psychiatristId,
      ]

      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')

        if (hasLegacyAnswersJson && hasLegacyUpdatedAt) {
          await client.query(
          `
          INSERT INTO questionnaire (
            student_id,
            mentalhealthsupport,
            concerns,
            period_affected,
            support_type,
            support_preferences,
            religion,
            religion_type,
            spiritual_status,
            therapy_status,
            seek_support,
            expectations,
            session_structure,
            communication,
            mentor_id,
            psychiatrist_id,
            answers_json,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, NOW(), NOW())
          ON CONFLICT (student_id)
          DO UPDATE SET
            mentalhealthsupport = EXCLUDED.mentalhealthsupport,
            concerns = EXCLUDED.concerns,
            period_affected = EXCLUDED.period_affected,
            support_type = EXCLUDED.support_type,
            support_preferences = EXCLUDED.support_preferences,
            religion = EXCLUDED.religion,
            religion_type = EXCLUDED.religion_type,
            spiritual_status = EXCLUDED.spiritual_status,
            therapy_status = EXCLUDED.therapy_status,
            seek_support = EXCLUDED.seek_support,
            expectations = EXCLUDED.expectations,
            session_structure = EXCLUDED.session_structure,
            communication = EXCLUDED.communication,
            mentor_id = EXCLUDED.mentor_id,
            psychiatrist_id = EXCLUDED.psychiatrist_id,
            answers_json = EXCLUDED.answers_json,
            updated_at = NOW()
          `,
          [...structuredValues, JSON.stringify(answers)]
          )
        } else if (hasLegacyAnswersJson) {
          await client.query(
          `
          INSERT INTO questionnaire (
            student_id,
            mentalhealthsupport,
            concerns,
            period_affected,
            support_type,
            support_preferences,
            religion,
            religion_type,
            spiritual_status,
            therapy_status,
            seek_support,
            expectations,
            session_structure,
            communication,
            mentor_id,
            psychiatrist_id,
            answers_json,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, NOW())
          ON CONFLICT (student_id)
          DO UPDATE SET
            mentalhealthsupport = EXCLUDED.mentalhealthsupport,
            concerns = EXCLUDED.concerns,
            period_affected = EXCLUDED.period_affected,
            support_type = EXCLUDED.support_type,
            support_preferences = EXCLUDED.support_preferences,
            religion = EXCLUDED.religion,
            religion_type = EXCLUDED.religion_type,
            spiritual_status = EXCLUDED.spiritual_status,
            therapy_status = EXCLUDED.therapy_status,
            seek_support = EXCLUDED.seek_support,
            expectations = EXCLUDED.expectations,
            session_structure = EXCLUDED.session_structure,
            communication = EXCLUDED.communication,
            mentor_id = EXCLUDED.mentor_id,
            psychiatrist_id = EXCLUDED.psychiatrist_id,
            answers_json = EXCLUDED.answers_json
          `,
          [...structuredValues, JSON.stringify(answers)]
          )
        } else if (hasLegacyUpdatedAt) {
          await client.query(
          `
          INSERT INTO questionnaire (
            student_id,
            mentalhealthsupport,
            concerns,
            period_affected,
            support_type,
            support_preferences,
            religion,
            religion_type,
            spiritual_status,
            therapy_status,
            seek_support,
            expectations,
            session_structure,
            communication,
            mentor_id,
            psychiatrist_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
          ON CONFLICT (student_id)
          DO UPDATE SET
            mentalhealthsupport = EXCLUDED.mentalhealthsupport,
            concerns = EXCLUDED.concerns,
            period_affected = EXCLUDED.period_affected,
            support_type = EXCLUDED.support_type,
            support_preferences = EXCLUDED.support_preferences,
            religion = EXCLUDED.religion,
            religion_type = EXCLUDED.religion_type,
            spiritual_status = EXCLUDED.spiritual_status,
            therapy_status = EXCLUDED.therapy_status,
            seek_support = EXCLUDED.seek_support,
            expectations = EXCLUDED.expectations,
            session_structure = EXCLUDED.session_structure,
            communication = EXCLUDED.communication,
            mentor_id = EXCLUDED.mentor_id,
            psychiatrist_id = EXCLUDED.psychiatrist_id,
            updated_at = NOW()
          `,
          structuredValues
          )
        } else {
          await client.query(
          `
          INSERT INTO questionnaire (
            student_id,
            mentalhealthsupport,
            concerns,
            period_affected,
            support_type,
            support_preferences,
            religion,
            religion_type,
            spiritual_status,
            therapy_status,
            seek_support,
            expectations,
            session_structure,
            communication,
            mentor_id,
            psychiatrist_id,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
          ON CONFLICT (student_id)
          DO UPDATE SET
            mentalhealthsupport = EXCLUDED.mentalhealthsupport,
            concerns = EXCLUDED.concerns,
            period_affected = EXCLUDED.period_affected,
            support_type = EXCLUDED.support_type,
            support_preferences = EXCLUDED.support_preferences,
            religion = EXCLUDED.religion,
            religion_type = EXCLUDED.religion_type,
            spiritual_status = EXCLUDED.spiritual_status,
            therapy_status = EXCLUDED.therapy_status,
            seek_support = EXCLUDED.seek_support,
            expectations = EXCLUDED.expectations,
            session_structure = EXCLUDED.session_structure,
            communication = EXCLUDED.communication,
            mentor_id = EXCLUDED.mentor_id,
            psychiatrist_id = EXCLUDED.psychiatrist_id
          `,
          structuredValues
          )
        }

        if (hasLegacySupportPreference) {
          await client.query('UPDATE questionnaire SET support_preference = $1 WHERE student_id = $2', [
            String(answers.support_preferences),
            resolvedStudentId,
          ])
        }

        await client.query(
          `
          INSERT INTO assignments (username, student_id, mentor_id, psychiatrist_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (student_id)
          DO UPDATE SET
            username = EXCLUDED.username,
            student_id = EXCLUDED.student_id,
            mentor_id = EXCLUDED.mentor_id,
            psychiatrist_id = EXCLUDED.psychiatrist_id
          `,
          [studentResult.rows[0].username, resolvedStudentId, mentorId, psychiatristId]
        )

        await client.query('COMMIT')
      } catch (txErr) {
        try {
          await client.query('ROLLBACK')
        } catch (_) {}
        throw txErr
      } finally {
        client.release()
      }

      const assignedTo = mentorId != null ? 'mentor' : psychiatristId != null ? 'psychiatrist' : null

      return res.json({
        ok: true,
        message: 'Questionnaire saved successfully.',
        assignedTo,
        mentorScore: decision.mentorScore,
        psychiatristScore: decision.psychiatristScore,
      })
    } catch (err) {
      console.error('Questionnaire save failed:', err.message)
      return res.status(500).json({ error: 'Failed to save questionnaire.' })
    }
  })

  app.get('/api/questionnaire/assigned-view', async (req, res) => {
    try {
      const role = sanitizeRole(req.query.role)
      const userId = Number(req.query.userId)
      if (!role || !Number.isInteger(userId)) return res.status(400).json({ error: 'role and userId are required' })

      if (role === 'mentor') {
        const result = await dbPool.query(
          `
          SELECT
            q.student_id,
            s.username,
            q.created_at,
            q.mentalhealthsupport,
            q.concerns,
            q.religion,
            q.religion_type,
            q.spiritual_status,
            q.seek_support,
            q.expectations,
            EXISTS (
              SELECT 1
              FROM messages m
              WHERE m.student_id = q.student_id
                AND m.mentor_id = q.mentor_id
            ) AS has_contact
          FROM questionnaire q
          INNER JOIN student s ON s.student_id = q.student_id
          WHERE q.mentor_id = $1
          ORDER BY q.created_at DESC
          `,
          [userId]
        )
        return res.json({ ok: true, rows: result.rows })
      }

      if (role === 'psychiatrist') {
        const result = await dbPool.query(
          `
          SELECT
            q.student_id,
            s.username,
            q.created_at,
            q.mentalhealthsupport,
            q.concerns,
            q.religion,
            q.religion_type,
            q.spiritual_status,
            q.therapy_status,
            q.seek_support,
            q.expectations,
            EXISTS (
              SELECT 1
              FROM messages m
              WHERE m.student_id = q.student_id
                AND m.psychiatrist_id = q.psychiatrist_id
            ) AS has_contact
          FROM questionnaire q
          INNER JOIN student s ON s.student_id = q.student_id
          WHERE q.psychiatrist_id = $1
          ORDER BY q.created_at DESC
          `,
          [userId]
        )
        return res.json({ ok: true, rows: result.rows })
      }

      return res.status(400).json({ error: 'Only mentor or psychiatrist can access assigned questionnaire view' })
    } catch (err) {
      console.error('Failed to load assigned questionnaire view:', err.message)
      return res.status(500).json({ error: 'Failed to load assigned questionnaire view' })
    }
  })

  app.get('/api/student/assigned-support', async (req, res) => {
    try {
      const studentId = Number(req.query.studentId)
      if (!Number.isInteger(studentId) || studentId <= 0) {
        return res.status(400).json({ error: 'Valid studentId is required' })
      }

      const tableExists = async (tableName) => {
        const check = await dbPool.query('SELECT to_regclass($1) AS reg', [`public.${tableName}`])
        return Boolean(check.rows[0] && check.rows[0].reg)
      }

      const questionnaireHasId = await dbPool.query(
        `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'questionnaire'
            AND column_name = 'questionnaire_id'
        ) AS exists
        `
      )

      let resolvedStudentId = studentId

      const studentTable = (await tableExists('student')) ? 'student' : (await tableExists('students')) ? 'students' : null
      if (studentTable === 'student') {
        const bySignup = await dbPool.query('SELECT student_id FROM student WHERE signup_id = $1 LIMIT 1', [studentId])
        if (bySignup.rows[0]) resolvedStudentId = Number(bySignup.rows[0].student_id)
      } else if (studentTable === 'students') {
        const bySignup = await dbPool.query('SELECT student_id FROM students WHERE signup_id = $1 LIMIT 1', [studentId])
        if (bySignup.rows[0]) resolvedStudentId = Number(bySignup.rows[0].student_id)
      }

      const hasAssignmentsTable = await tableExists('assignments')
      let row = null

      if (hasAssignmentsTable) {
        const assignment = await dbPool.query(
          `
          SELECT mentor_id, psychiatrist_id
          FROM assignments
          WHERE student_id = $1
          LIMIT 1
          `,
          [resolvedStudentId]
        )
        row = assignment.rows[0] || null
      }

      // Backward compatibility for older data where assignment IDs only existed on questionnaire rows.
      if (!row || (!row.mentor_id && !row.psychiatrist_id)) {
        const questionnaireAssignment = await dbPool.query(
          `
          SELECT mentor_id, psychiatrist_id
          FROM questionnaire
          WHERE student_id = $1
          ${questionnaireHasId.rows[0] && questionnaireHasId.rows[0].exists ? 'ORDER BY questionnaire_id DESC' : ''}
          LIMIT 1
          `,
          [resolvedStudentId]
        )
        row = questionnaireAssignment.rows[0] || null
      }

      if (!row || (!row.mentor_id && !row.psychiatrist_id)) {
        return res.json({ ok: true, assigned: false })
      }

      if (row.mentor_id) {
        const mentorTable = (await tableExists('mentor')) ? 'mentor' : (await tableExists('mentors')) ? 'mentors' : null
        if (!mentorTable) {
          return res.json({ ok: true, assigned: false })
        }

        const mentorProfile = await dbPool.query(
          `
          SELECT
            m.mentor_id,
            m.full_name,
            m.email,
            m.phone_no,
            m.bio
          FROM ${mentorTable} m
          WHERE m.mentor_id = $1
          LIMIT 1
          `,
          [Number(row.mentor_id)]
        )

        if (!mentorProfile.rows[0]) {
          return res.json({ ok: true, assigned: false })
        }

        return res.json({
          ok: true,
          assigned: true,
          assignedRole: 'mentor',
          assignedId: Number(row.mentor_id),
          profile: mentorProfile.rows[0] || {},
        })
      }

      const psychiatristTable = (await tableExists('psychiatrist'))
        ? 'psychiatrist'
        : (await tableExists('psychiatrists'))
          ? 'psychiatrists'
          : null
      if (!psychiatristTable) {
        return res.json({ ok: true, assigned: false })
      }

      const psychiatristProfile = await dbPool.query(
        `
        SELECT
          p.psychiatrist_id,
          p.full_name,
          p.email,
          p.phone_no,
          p.certification,
          p.licence_number,
          p.years_of_experience,
          p.billing_details
        FROM ${psychiatristTable} p
        WHERE p.psychiatrist_id = $1
        LIMIT 1
        `,
        [Number(row.psychiatrist_id)]
      )

      if (!psychiatristProfile.rows[0]) {
        return res.json({ ok: true, assigned: false })
      }

      return res.json({
        ok: true,
        assigned: true,
        assignedRole: 'psychiatrist',
        assignedId: Number(row.psychiatrist_id),
        profile: psychiatristProfile.rows[0] || {},
      })
    } catch (err) {
      console.error('Failed to load student assigned support:', err.message)
      return res.status(500).json({ error: 'Failed to load assigned support profile' })
    }
  })
}

module.exports = { setupQuestionnaireRoutes }

const { verifySessionToken } = require('../auth/sessionToken')

function setupAdminOpsRoutes({
  app,
  dbPool,
  ensureAdminOpsSchema,
  parsePositiveInt,
  parseNonNegativeInt,
  parseNullablePhone,
  normalizeTherapistType,
  toIsoString,
  findLeastLoadedAssignee,
}) {
  const requireAdminRequest = (req, res, next) => {
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

    if (String(sessionClaims.role || '').trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ error: 'Admin access is required.' })
    }

    req.sessionClaims = sessionClaims
    return next()
  }

  app.use('/api/admin', requireAdminRequest)
  app.use('/api/complaints', requireAdminRequest)
  app.use('/api/resources', requireAdminRequest)

  app.put('/api/admin/kpis', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const totalStudents = parseNonNegativeInt(req.body?.totalStudents)
      const mentorsActive = parseNonNegativeInt(req.body?.mentorsActive)
      const psychiatristsActive = parseNonNegativeInt(req.body?.psychiatristsActive)
      const assignmentsActive = parseNonNegativeInt(req.body?.assignmentsActive)

      await dbPool.query(
        `
        INSERT INTO admin_kpi_overrides (
          override_id,
          total_students,
          mentors_active,
          psychiatrists_active,
          assignments_active,
          updated_at
        )
        VALUES (1, $1, $2, $3, $4, NOW())
        ON CONFLICT (override_id)
        DO UPDATE SET
          total_students = EXCLUDED.total_students,
          mentors_active = EXCLUDED.mentors_active,
          psychiatrists_active = EXCLUDED.psychiatrists_active,
          assignments_active = EXCLUDED.assignments_active,
          updated_at = NOW()
        `,
        [totalStudents, mentorsActive, psychiatristsActive, assignmentsActive]
      )

      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to update KPI overrides:', err.message)
      return res.status(500).json({ error: 'Failed to update KPI overrides.' })
    }
  })

  app.delete('/api/admin/kpis', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)
      await dbPool.query('DELETE FROM admin_kpi_overrides WHERE override_id = 1')
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to clear KPI overrides:', err.message)
      return res.status(500).json({ error: 'Failed to clear KPI overrides.' })
    }
  })

  app.post('/api/complaints', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const studentId = parsePositiveInt(req.body?.studentId)
      const issueType = String(req.body?.issueType || 'assignment').trim().toLowerCase().slice(0, 50)
      const details = String(req.body?.details || '').trim().slice(0, 2000)
      const preferredRole = normalizeTherapistType(req.body?.preferredRole)
      const againstRole = normalizeTherapistType(req.body?.againstRole)
      const againstId = parsePositiveInt(req.body?.againstId)

      if (!studentId) return res.status(400).json({ error: 'Valid studentId is required.' })
      if (!details) return res.status(400).json({ error: 'Complaint details are required.' })

      const currentAssignment = await dbPool.query(
        'SELECT mentor_id, psychiatrist_id FROM assignments WHERE student_id = $1 LIMIT 1',
        [studentId]
      )

      const assignmentRow = currentAssignment.rows[0] || {}
      const currentAssignedRole =
        againstRole ||
        (assignmentRow.mentor_id != null ? 'mentor' : assignmentRow.psychiatrist_id != null ? 'psychiatrist' : null)

      const currentAssignedId =
        currentAssignedRole === 'mentor'
          ? assignmentRow.mentor_id == null
            ? null
            : Number(assignmentRow.mentor_id)
          : currentAssignedRole === 'psychiatrist'
            ? assignmentRow.psychiatrist_id == null
              ? null
              : Number(assignmentRow.psychiatrist_id)
            : null

      const inserted = await dbPool.query(
        `
        INSERT INTO complaints (
          student_id,
          issue_type,
          details,
          preferred_role,
          against_role,
          against_id,
          current_assigned_role,
          current_assigned_id,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', NOW(), NOW())
        RETURNING complaint_id
        `,
        [
          studentId,
          issueType,
          details,
          preferredRole,
          againstRole,
          againstId,
          currentAssignedRole,
          currentAssignedId,
        ]
      )

      return res.status(201).json({ ok: true, complaintId: Number(inserted.rows[0].complaint_id) })
    } catch (err) {
      console.error('Failed to submit complaint:', err.message)
      return res.status(500).json({ error: 'Failed to submit complaint.' })
    }
  })

  app.get('/api/admin/complaints', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const statusFilter = String(req.query.status || 'all').trim().toLowerCase()
      const includeAll = statusFilter === 'all' || !statusFilter

      const query = `
        SELECT
          c.complaint_id,
          c.student_id,
          s.username AS student_username,
          s.email AS student_email,
          c.issue_type,
          c.details,
          c.preferred_role,
          c.against_role,
          c.against_id,
          c.current_assigned_role,
          c.current_assigned_id,
          c.status,
          c.resolution_note,
          c.reassigned_role,
          c.reassigned_id,
          c.admin_signup_id,
          c.created_at,
          c.updated_at,
          c.resolved_at,
          m.full_name AS against_mentor_name,
          p.full_name AS against_psychiatrist_name
        FROM complaints c
        INNER JOIN student s ON s.student_id = c.student_id
        LEFT JOIN mentor m ON m.mentor_id = c.against_id
        LEFT JOIN psychiatrist p ON p.psychiatrist_id = c.against_id
        ${includeAll ? '' : 'WHERE LOWER(c.status) = $1'}
        ORDER BY c.created_at DESC
      `

      const result = await dbPool.query(query, includeAll ? [] : [statusFilter])

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          complaintId: Number(row.complaint_id),
          studentId: Number(row.student_id),
          studentUsername: String(row.student_username || ''),
          studentEmail: String(row.student_email || ''),
          issueType: String(row.issue_type || ''),
          details: String(row.details || ''),
          preferredRole: String(row.preferred_role || ''),
          againstRole: String(row.against_role || ''),
          againstId: row.against_id == null ? null : Number(row.against_id),
          againstName: String(row.against_mentor_name || row.against_psychiatrist_name || ''),
          currentAssignedRole: String(row.current_assigned_role || ''),
          currentAssignedId: row.current_assigned_id == null ? null : Number(row.current_assigned_id),
          status: String(row.status || 'open'),
          resolutionNote: String(row.resolution_note || ''),
          reassignedRole: String(row.reassigned_role || ''),
          reassignedId: row.reassigned_id == null ? null : Number(row.reassigned_id),
          adminSignupId: row.admin_signup_id == null ? null : Number(row.admin_signup_id),
          createdAt: toIsoString(row.created_at),
          updatedAt: toIsoString(row.updated_at),
          resolvedAt: toIsoString(row.resolved_at),
        })),
      })
    } catch (err) {
      console.error('Failed to load complaints:', err.message)
      return res.status(500).json({ error: 'Failed to load complaints.' })
    }
  })

  app.put('/api/admin/complaints/:complaintId/reassign', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const complaintId = parsePositiveInt(req.params.complaintId)
      const newRole = normalizeTherapistType(req.body?.newRole)
      const requestedAssigneeId = parsePositiveInt(req.body?.newAssigneeId)
      const adminSignupId = parsePositiveInt(req.body?.adminSignupId)
      const resolutionNote = String(req.body?.resolutionNote || '').trim().slice(0, 1000)

      if (!complaintId) return res.status(400).json({ error: 'Valid complaintId is required.' })
      if (!newRole) return res.status(400).json({ error: 'newRole must be mentor or psychiatrist.' })

      const complaintResult = await dbPool.query(
        'SELECT complaint_id, student_id, status FROM complaints WHERE complaint_id = $1 LIMIT 1',
        [complaintId]
      )
      if (!complaintResult.rows[0]) return res.status(404).json({ error: 'Complaint not found.' })

      const complaint = complaintResult.rows[0]
      const studentId = Number(complaint.student_id)

      let selectedAssigneeId = requestedAssigneeId
      if (!selectedAssigneeId) {
        selectedAssigneeId = await findLeastLoadedAssignee(dbPool, newRole)
      }
      if (!selectedAssigneeId) {
        return res.status(409).json({ error: `No available ${newRole} found for reassignment.` })
      }

      if (newRole === 'mentor') {
        const exists = await dbPool.query('SELECT mentor_id FROM mentor WHERE mentor_id = $1 LIMIT 1', [selectedAssigneeId])
        if (!exists.rows[0]) return res.status(404).json({ error: 'Selected mentor not found.' })
      }
      if (newRole === 'psychiatrist') {
        const exists = await dbPool.query('SELECT psychiatrist_id FROM psychiatrist WHERE psychiatrist_id = $1 LIMIT 1', [
          selectedAssigneeId,
        ])
        if (!exists.rows[0]) return res.status(404).json({ error: 'Selected psychiatrist not found.' })
      }

      const existingAssignment = await dbPool.query(
        'SELECT mentor_id, psychiatrist_id FROM assignments WHERE student_id = $1 LIMIT 1',
        [studentId]
      )
      const assignmentRow = existingAssignment.rows[0] || {}

      const nextMentorId =
        newRole === 'mentor'
          ? selectedAssigneeId
          : assignmentRow.mentor_id == null
            ? null
            : Number(assignmentRow.mentor_id)

      const nextPsychiatristId =
        newRole === 'psychiatrist'
          ? selectedAssigneeId
          : assignmentRow.psychiatrist_id == null
            ? null
            : Number(assignmentRow.psychiatrist_id)

      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')

        await client.query(
          `
          INSERT INTO assignments (username, student_id, mentor_id, psychiatrist_id)
          VALUES (
            (SELECT username FROM student WHERE student_id = $1 LIMIT 1),
            $1,
            $2,
            $3
          )
          ON CONFLICT (student_id)
          DO UPDATE SET
            mentor_id = EXCLUDED.mentor_id,
            psychiatrist_id = EXCLUDED.psychiatrist_id
          `,
          [studentId, nextMentorId, nextPsychiatristId]
        )

        if (newRole === 'mentor') {
          await client.query('UPDATE questionnaire SET mentor_id = $2 WHERE student_id = $1', [studentId, selectedAssigneeId])
        } else {
          await client.query('UPDATE questionnaire SET psychiatrist_id = $2 WHERE student_id = $1', [
            studentId,
            selectedAssigneeId,
          ])
        }

        await client.query(
          `
          UPDATE complaints
          SET
            status = 'resolved',
            reassigned_role = $2,
            reassigned_id = $3,
            admin_signup_id = $4,
            resolution_note = $5,
            resolved_at = NOW(),
            updated_at = NOW()
          WHERE complaint_id = $1
          `,
          [complaintId, newRole, selectedAssigneeId, adminSignupId, resolutionNote || null]
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

      return res.json({
        ok: true,
        complaintId,
        studentId,
        reassignedRole: newRole,
        reassignedId: selectedAssigneeId,
      })
    } catch (err) {
      console.error('Failed to reassign complaint:', err.message)
      return res.status(500).json({ error: 'Failed to process complaint reassignment.' })
    }
  })

  app.get('/api/admin/resources', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const result = await dbPool.query(
        `
        SELECT
          r.resource_id,
          r.title,
          r.category,
          r.description,
          r.resource_content,
          r.file_link,
          r.created_at,
          r.student_id,
          s.username AS student_username
        FROM resource r
        LEFT JOIN student s ON s.student_id = r.student_id
        ORDER BY r.resource_id DESC
        `
      )

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          resourceId: Number(row.resource_id),
          title: String(row.title || ''),
          category: String(row.category || ''),
          description: String(row.description || ''),
          resourceContent: String(row.resource_content || ''),
          fileLink: String(row.file_link || ''),
          createdAt: toIsoString(row.created_at),
          studentId: row.student_id == null ? null : Number(row.student_id),
          studentUsername: String(row.student_username || ''),
        })),
      })
    } catch (err) {
      console.error('Failed to load resources:', err.message)
      return res.status(500).json({ error: 'Failed to load resources.' })
    }
  })

  app.get('/api/resources', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const result = await dbPool.query(
        `
        SELECT
          r.resource_id,
          r.title,
          r.category,
          r.description,
          r.resource_content,
          r.file_link,
          r.created_at
        FROM resource r
        ORDER BY r.created_at DESC, r.resource_id DESC
        `
      )

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          resourceId: Number(row.resource_id),
          title: String(row.title || ''),
          category: String(row.category || ''),
          description: String(row.description || ''),
          resourceContent: String(row.resource_content || ''),
          fileLink: String(row.file_link || ''),
          createdAt: toIsoString(row.created_at),
        })),
      })
    } catch (err) {
      console.error('Failed to load student resources:', err.message)
      return res.status(500).json({ error: 'Failed to load resources.' })
    }
  })

  app.post('/api/admin/resources', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const title = String(req.body?.title || '').trim().slice(0, 200)
      const category = String(req.body?.category || '').trim().slice(0, 100)
      const description = String(req.body?.description || '').trim().slice(0, 500)
      const resourceContent = String(req.body?.resourceContent || '').trim().slice(0, 20000)
      const studentId = parsePositiveInt(req.body?.studentId)

      if (!title) return res.status(400).json({ error: 'Title is required.' })

      const inserted = await dbPool.query(
        `
        INSERT INTO resource (title, category, description, resource_content, file_link, student_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING resource_id
        `,
        [title, category || null, description || null, resourceContent || null, null, studentId]
      )

      return res.status(201).json({ ok: true, resourceId: Number(inserted.rows[0].resource_id) })
    } catch (err) {
      console.error('Failed to create resource:', err.message)
      return res.status(500).json({ error: 'Failed to create resource.' })
    }
  })

  app.put('/api/admin/resources/:resourceId', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const resourceId = parsePositiveInt(req.params.resourceId)
      const title = String(req.body?.title || '').trim().slice(0, 200)
      const category = String(req.body?.category || '').trim().slice(0, 100)
      const description = String(req.body?.description || '').trim().slice(0, 500)
      const resourceContent = String(req.body?.resourceContent || '').trim().slice(0, 20000)
      const studentId = parsePositiveInt(req.body?.studentId)

      if (!resourceId) return res.status(400).json({ error: 'Valid resourceId is required.' })
      if (!title) return res.status(400).json({ error: 'Title is required.' })

      const updated = await dbPool.query(
        `
        UPDATE resource
        SET title = $1,
            category = $2,
            description = $3,
            resource_content = $4,
            file_link = NULL,
            student_id = $5
        WHERE resource_id = $6
        RETURNING resource_id
        `,
        [title, category || null, description || null, resourceContent || null, studentId, resourceId]
      )

      if (!updated.rows[0]) return res.status(404).json({ error: 'Resource not found.' })
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to update resource:', err.message)
      return res.status(500).json({ error: 'Failed to update resource.' })
    }
  })

  app.delete('/api/admin/resources/:resourceId', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)
      const resourceId = parsePositiveInt(req.params.resourceId)
      if (!resourceId) return res.status(400).json({ error: 'Valid resourceId is required.' })

      const deleted = await dbPool.query('DELETE FROM resource WHERE resource_id = $1 RETURNING resource_id', [resourceId])
      if (!deleted.rows[0]) return res.status(404).json({ error: 'Resource not found.' })

      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to delete resource:', err.message)
      return res.status(500).json({ error: 'Failed to delete resource.' })
    }
  })

  app.get('/api/resources/:resourceId', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const resourceId = parsePositiveInt(req.params.resourceId)
      if (!resourceId) return res.status(400).json({ error: 'Valid resourceId is required.' })

      const result = await dbPool.query(
        `
        SELECT
          resource_id,
          title,
          category,
          description,
          resource_content,
          file_link,
          created_at
        FROM resource
        WHERE resource_id = $1
        LIMIT 1
        `,
        [resourceId]
      )

      if (!result.rows[0]) return res.status(404).json({ error: 'Resource not found.' })

      const row = result.rows[0]
      return res.json({
        ok: true,
        resource: {
          resourceId: Number(row.resource_id),
          title: String(row.title || ''),
          category: String(row.category || ''),
          description: String(row.description || ''),
          resourceContent: String(row.resource_content || ''),
          fileLink: String(row.file_link || ''),
          createdAt: toIsoString(row.created_at),
        },
      })
    } catch (err) {
      console.error('Failed to load resource details:', err.message)
      return res.status(500).json({ error: 'Failed to load resource details.' })
    }
  })

  app.get('/api/admin/emergency-contacts', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const result = await dbPool.query(
        `
        SELECT
          e.contact_id,
          COALESCE(e.conatct_name, e.contact_name) AS contact_name,
          e.phone_no,
          e.student_id,
          s.username AS student_username
        FROM emergency_contact e
        LEFT JOIN student s ON s.student_id = e.student_id
        ORDER BY e.contact_id DESC
        `
      )

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          contactId: Number(row.contact_id),
          contactName: String(row.contact_name || ''),
          phoneNo: row.phone_no == null ? '' : String(row.phone_no),
          studentId: row.student_id == null ? null : Number(row.student_id),
          studentUsername: String(row.student_username || ''),
        })),
      })
    } catch (err) {
      console.error('Failed to load emergency contacts:', err.message)
      return res.status(500).json({ error: 'Failed to load emergency contacts.' })
    }
  })

  app.post('/api/admin/emergency-contacts', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const contactName = String(req.body?.contactName || '').trim().slice(0, 100)
      const phoneNo = parseNullablePhone(req.body?.phoneNo)
      const studentId = parsePositiveInt(req.body?.studentId)

      if (!contactName) return res.status(400).json({ error: 'Contact name is required.' })

      const inserted = await dbPool.query(
        `
        INSERT INTO emergency_contact (conatct_name, contact_name, phone_no, student_id)
        VALUES ($1, $1, $2, $3)
        RETURNING contact_id
        `,
        [contactName, phoneNo, studentId]
      )

      return res.status(201).json({ ok: true, contactId: Number(inserted.rows[0].contact_id) })
    } catch (err) {
      console.error('Failed to create emergency contact:', err.message)
      return res.status(500).json({ error: 'Failed to create emergency contact.' })
    }
  })

  app.put('/api/admin/emergency-contacts/:contactId', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const contactId = parsePositiveInt(req.params.contactId)
      const contactName = String(req.body?.contactName || '').trim().slice(0, 100)
      const phoneNo = parseNullablePhone(req.body?.phoneNo)
      const studentId = parsePositiveInt(req.body?.studentId)

      if (!contactId) return res.status(400).json({ error: 'Valid contactId is required.' })
      if (!contactName) return res.status(400).json({ error: 'Contact name is required.' })

      const updated = await dbPool.query(
        `
        UPDATE emergency_contact
        SET conatct_name = $1,
            contact_name = $1,
            phone_no = $2,
            student_id = $3
        WHERE contact_id = $4
        RETURNING contact_id
        `,
        [contactName, phoneNo, studentId, contactId]
      )

      if (!updated.rows[0]) return res.status(404).json({ error: 'Emergency contact not found.' })
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to update emergency contact:', err.message)
      return res.status(500).json({ error: 'Failed to update emergency contact.' })
    }
  })

  app.delete('/api/admin/emergency-contacts/:contactId', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)
      const contactId = parsePositiveInt(req.params.contactId)
      if (!contactId) return res.status(400).json({ error: 'Valid contactId is required.' })

      const deleted = await dbPool.query('DELETE FROM emergency_contact WHERE contact_id = $1 RETURNING contact_id', [contactId])
      if (!deleted.rows[0]) return res.status(404).json({ error: 'Emergency contact not found.' })

      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to delete emergency contact:', err.message)
      return res.status(500).json({ error: 'Failed to delete emergency contact.' })
    }
  })
}

module.exports = { setupAdminOpsRoutes }

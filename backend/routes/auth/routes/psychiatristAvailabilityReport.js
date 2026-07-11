function setupPsychiatristAvailabilityReportRoutes(app, dbPool, deps) {
  const {
    ensurePsychiatristWorkspaceSchema,
    ensureAppointmentSchema,
    resolvePsychiatristWorkspaceId,
    parsePositiveInt,
    toUtcDateFloor,
    ensureGeneratedAvailabilitySlots,
    toIsoString,
  } = deps

  // Psychiatrist calendar query endpoint.
  app.get('/api/psychiatrist/calendar', async (req, res) => {
    try {
      await ensureAppointmentSchema(dbPool)

      const psychiatristId = await resolvePsychiatristWorkspaceId(dbPool, req.query.psychiatristId)
      const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : new Date()
      const days = Math.min(parsePositiveInt(req.query.days) || 30, 60)

      if (!psychiatristId) {
        return res.status(404).json({ error: 'Psychiatrist profile not found. Complete psychiatrist profile setup first.' })
      }

      const startDateFloor = toUtcDateFloor(startDate)
      if (!startDateFloor) return res.status(400).json({ error: 'Invalid startDate.' })

      const endDate = new Date(startDateFloor)
      endDate.setUTCDate(endDate.getUTCDate() + days)

      await ensureGeneratedAvailabilitySlots(dbPool, {
        therapistType: 'psychiatrist',
        therapistId: psychiatristId,
        startDate: startDateFloor,
        endDate,
      })

      const availabilityRows = await dbPool.query(
        `
        SELECT availability_id, start_at, end_at, is_available
        FROM therapist_availability
        WHERE therapist_type = 'psychiatrist'
          AND therapist_id = $1
          AND start_at >= $2
          AND start_at < $3
        ORDER BY start_at ASC
        `,
        [psychiatristId, startDateFloor.toISOString(), endDate.toISOString()]
      )

      const bookedRows = await dbPool.query(
        `
        SELECT availability_id
        FROM appointments
        WHERE therapist_type = 'psychiatrist'
          AND therapist_id = $1
          AND status = 'booked'
          AND slot_start >= $2
          AND slot_start < $3
        `,
        [psychiatristId, startDateFloor.toISOString(), endDate.toISOString()]
      )

      const bookedSet = new Set(bookedRows.rows.map((row) => Number(row.availability_id)))

      const slots = availabilityRows.rows.map((row) => ({
        availabilityId: Number(row.availability_id),
        startAt: toIsoString(row.start_at),
        endAt: toIsoString(row.end_at),
        status: Boolean(row.is_available) && !bookedSet.has(Number(row.availability_id)) ? 'available' : 'booked',
      }))

      return res.json({ ok: true, psychiatristId, slots })
    } catch (err) {
      console.error('Failed to load psychiatrist calendar:', err.message)
      return res.status(500).json({ error: 'Failed to load psychiatrist calendar.' })
    }
  })

  // Generate psychiatrist case summary report.
  app.get('/api/psychiatrist/case-report', async (req, res) => {
    try {
      await ensurePsychiatristWorkspaceSchema(dbPool)
      await ensureAppointmentSchema(dbPool)

      const psychiatristId = await resolvePsychiatristWorkspaceId(dbPool, req.query.psychiatristId)
      if (!psychiatristId) {
        return res.status(404).json({ error: 'Psychiatrist profile not found. Complete psychiatrist profile setup first.' })
      }

      const assignedResult = await dbPool.query(
        `
        SELECT
          a.student_id,
          s.username,
          q.concerns,
          q.therapy_status,
          q.support_type,
          q.updated_at
        FROM assignments a
        LEFT JOIN student s ON s.student_id = a.student_id
        LEFT JOIN questionnaire q ON q.student_id = a.student_id
        WHERE a.psychiatrist_id = $1
        ORDER BY a.student_id ASC
        `,
        [psychiatristId]
      )

      const upcomingAppointments = await dbPool.query(
        `
        SELECT COUNT(*)::int AS total
        FROM appointments
        WHERE therapist_type = 'psychiatrist'
          AND therapist_id = $1
          AND status = 'booked'
          AND slot_start >= NOW()
        `,
        [psychiatristId]
      )

      const noteCountResult = await dbPool.query(
        'SELECT COUNT(*)::int AS total FROM psychiatrist_notes WHERE psychiatrist_id = $1',
        [psychiatristId]
      )

      const riskCountResult = await dbPool.query(
        'SELECT COUNT(*)::int AS total FROM psychiatrist_risk_overview WHERE psychiatrist_id = $1',
        [psychiatristId]
      )

      const assignedRows = assignedResult.rows || []
      const summary = {
        totalAssignedStudents: assignedRows.length,
        upcomingAppointments: Number(upcomingAppointments.rows[0]?.total || 0),
        savedClinicalNotes: Number(noteCountResult.rows[0]?.total || 0),
        riskOverviewItems: Number(riskCountResult.rows[0]?.total || 0),
      }

      const lines = []
      lines.push('Tuliza Psychiatrist Case Report')
      lines.push(`Generated: ${new Date().toISOString()}`)
      lines.push(`Psychiatrist ID: ${psychiatristId}`)
      lines.push('')
      lines.push(`Total assigned students: ${summary.totalAssignedStudents}`)
      lines.push(`Upcoming appointments: ${summary.upcomingAppointments}`)
      lines.push(`Saved clinical notes: ${summary.savedClinicalNotes}`)
      lines.push(`Risk overview items: ${summary.riskOverviewItems}`)
      lines.push('')
      lines.push('Assigned student snapshots:')

      if (!assignedRows.length) {
        lines.push('- No currently assigned students.')
      } else {
        assignedRows.forEach((row) => {
          lines.push(
            `- Student ${row.student_id || '-'} (${row.username || 'Unknown'}): concerns=${row.concerns || 'N/A'}; therapy_status=${row.therapy_status || 'N/A'}; support_type=${row.support_type || 'N/A'}`
          )
        })
      }

      return res.json({
        ok: true,
        psychiatristId,
        summary,
        reportText: lines.join('\n'),
      })
    } catch (err) {
      console.error('Failed to generate psychiatrist case report:', err.message)
      return res.status(500).json({ error: 'Failed to generate case report.' })
    }
  })
}

module.exports = { setupPsychiatristAvailabilityReportRoutes }

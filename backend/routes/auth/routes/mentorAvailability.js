function setupMentorAvailabilityRoutes(app, dbPool, deps) {
  const {
    ensureAppointmentSchema,
    resolveMentorWorkspaceId,
    parsePositiveInt,
    isWithinWorkingHours,
    toUtcDateFloor,
    ensureGeneratedAvailabilitySlots,
    toIsoString,
  } = deps

  // Mentor calendar availability management endpoints.
  app.post('/api/mentor/availability', async (req, res) => {
    try {
      await ensureAppointmentSchema(dbPool)

      const mentorId = await resolveMentorWorkspaceId(dbPool, req.body?.mentorId)
      const startAtRaw = String(req.body?.startAt || '').trim()
      const endAtRaw = String(req.body?.endAt || '').trim()

      if (!mentorId) {
        return res.status(404).json({ error: 'Mentor profile not found. Complete mentor profile setup first.' })
      }

      const startAt = new Date(startAtRaw)
      const endAt = new Date(endAtRaw)
      if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
        return res.status(400).json({ error: 'Valid startAt and endAt values are required.' })
      }
      if (endAt <= startAt) {
        return res.status(400).json({ error: 'endAt must be later than startAt.' })
      }
      if (!isWithinWorkingHours(startAt, endAt)) {
        return res.status(400).json({ error: 'Availability must be within working hours (Mon-Fri 08:00-17:00, Sat 09:00-12:00).' })
      }

      const overlap = await dbPool.query(
        `
        SELECT availability_id
        FROM therapist_availability
        WHERE therapist_type = 'mentor'
          AND therapist_id = $1
          AND start_at < $3
          AND end_at > $2
        LIMIT 1
        `,
        [mentorId, startAt.toISOString(), endAt.toISOString()]
      )

      if (overlap.rows[0]) {
        return res.status(409).json({ error: 'This availability overlaps with an existing slot.' })
      }

      const inserted = await dbPool.query(
        `
        INSERT INTO therapist_availability (therapist_type, therapist_id, start_at, end_at, is_available, created_at, updated_at)
        VALUES ('mentor', $1, $2, $3, TRUE, NOW(), NOW())
        RETURNING availability_id
        `,
        [mentorId, startAt.toISOString(), endAt.toISOString()]
      )

      return res.status(201).json({ ok: true, availabilityId: Number(inserted.rows[0].availability_id) })
    } catch (err) {
      console.error('Failed to create mentor availability:', err.message)
      return res.status(500).json({ error: 'Failed to create availability slot.' })
    }
  })

  app.delete('/api/mentor/availability/:availabilityId', async (req, res) => {
    try {
      await ensureAppointmentSchema(dbPool)

      const availabilityId = parsePositiveInt(req.params.availabilityId)
      const mentorId = await resolveMentorWorkspaceId(dbPool, req.query.mentorId)

      if (!availabilityId) return res.status(400).json({ error: 'Valid availabilityId is required.' })
      if (!mentorId) {
        return res.status(404).json({ error: 'Mentor profile not found. Complete mentor profile setup first.' })
      }

      const deleted = await dbPool.query(
        `
        DELETE FROM therapist_availability
        WHERE availability_id = $1
          AND therapist_type = 'mentor'
          AND therapist_id = $2
          AND is_available = TRUE
        RETURNING availability_id
        `,
        [availabilityId, mentorId]
      )

      if (!deleted.rows[0]) {
        return res.status(404).json({ error: 'Availability slot not found or already booked.' })
      }

      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to delete mentor availability:', err.message)
      return res.status(500).json({ error: 'Failed to delete availability slot.' })
    }
  })

  // Mentor calendar query endpoint.
  app.get('/api/mentor/calendar', async (req, res) => {
    try {
      await ensureAppointmentSchema(dbPool)

      const mentorId = await resolveMentorWorkspaceId(dbPool, req.query.mentorId)
      const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : new Date()
      const days = Math.min(parsePositiveInt(req.query.days) || 30, 60)

      if (!mentorId) {
        return res.status(404).json({ error: 'Mentor profile not found. Complete mentor profile setup first.' })
      }

      const startDateFloor = toUtcDateFloor(startDate)
      if (!startDateFloor) return res.status(400).json({ error: 'Invalid startDate.' })

      const endDate = new Date(startDateFloor)
      endDate.setUTCDate(endDate.getUTCDate() + days)

      await ensureGeneratedAvailabilitySlots(dbPool, {
        therapistType: 'mentor',
        therapistId: mentorId,
        startDate: startDateFloor,
        endDate,
      })

      const availabilityRows = await dbPool.query(
        `
        SELECT availability_id, start_at, end_at, is_available
        FROM therapist_availability
        WHERE therapist_type = 'mentor'
          AND therapist_id = $1
          AND start_at >= $2
          AND start_at < $3
        ORDER BY start_at ASC
        `,
        [mentorId, startDateFloor.toISOString(), endDate.toISOString()]
      )

      const bookedRows = await dbPool.query(
        `
        SELECT availability_id
        FROM appointments
        WHERE therapist_type = 'mentor'
          AND therapist_id = $1
          AND status = 'booked'
          AND slot_start >= $2
          AND slot_start < $3
        `,
        [mentorId, startDateFloor.toISOString(), endDate.toISOString()]
      )

      const bookedSet = new Set(bookedRows.rows.map((row) => Number(row.availability_id)))

      const slots = availabilityRows.rows.map((row) => ({
        availabilityId: Number(row.availability_id),
        startAt: toIsoString(row.start_at),
        endAt: toIsoString(row.end_at),
        status: Boolean(row.is_available) && !bookedSet.has(Number(row.availability_id)) ? 'available' : 'booked',
      }))

      return res.json({ ok: true, mentorId, slots })
    } catch (err) {
      console.error('Failed to load mentor calendar:', err.message)
      return res.status(500).json({ error: 'Failed to load mentor calendar.' })
    }
  })
}

module.exports = { setupMentorAvailabilityRoutes }

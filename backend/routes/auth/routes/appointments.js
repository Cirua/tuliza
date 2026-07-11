function setupAppointmentsRoutes(app, dbPool, {
  parsePositiveInt,
  normalizeTherapistType,
  toUtcDateFloor,
  toIsoString,
  ensureAppointmentSchema,
  ensureGeneratedAvailabilitySlots,
  isWithinWorkingHours,
  getWorkingWindowByDay,
} = {}) {
  // Return generated and persisted availability slots for booking calendar.
  app.get('/api/appointments/availability', async (req, res) => {
    const therapistType = normalizeTherapistType(req.query.therapistType)
    const therapistId = parsePositiveInt(req.query.therapistId)
    const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : new Date()
    const days = Math.min(parsePositiveInt(req.query.days) || 14, 31)

    if (!therapistType || !therapistId) {
      res.status(400).json({ error: 'therapistType and therapistId are required.' })
      return
    }

    const startDateFloor = toUtcDateFloor(startDate)
    if (!startDateFloor) {
      res.status(400).json({ error: 'Invalid startDate.' })
      return
    }

    const todayFloor = toUtcDateFloor(new Date())
    const effectiveStart = startDateFloor < todayFloor ? todayFloor : startDateFloor
    const endDate = new Date(effectiveStart)
    endDate.setUTCDate(endDate.getUTCDate() + days)

    try {
      await ensureAppointmentSchema(dbPool)
      await ensureGeneratedAvailabilitySlots(dbPool, {
        therapistType,
        therapistId,
        startDate: effectiveStart,
        endDate,
      })

      const availabilityRows = await dbPool.query(
        `
        SELECT
          availability_id,
          start_at,
          end_at,
          is_available
        FROM therapist_availability
        WHERE therapist_type = $1
          AND therapist_id = $2
          AND start_at >= $3
          AND start_at < $4
        ORDER BY start_at ASC
        `,
        [therapistType, therapistId, effectiveStart.toISOString(), endDate.toISOString()]
      )

      const bookedRows = await dbPool.query(
        `
        SELECT availability_id
        FROM appointments
        WHERE therapist_type = $1
          AND therapist_id = $2
          AND slot_start >= $3
          AND slot_start < $4
          AND status = 'booked'
        `,
        [therapistType, therapistId, effectiveStart.toISOString(), endDate.toISOString()]
      )

      const bookedIds = new Set(bookedRows.rows.map((row) => Number(row.availability_id)))
      const slots = availabilityRows.rows
        .map((row) => {
          if (!isWithinWorkingHours(row.start_at, row.end_at)) {
            return null
          }

          const availableFlag = Boolean(row.is_available) && !bookedIds.has(Number(row.availability_id))
          return {
            availabilityId: Number(row.availability_id),
            startAt: toIsoString(row.start_at),
            endAt: toIsoString(row.end_at),
            status: availableFlag ? 'available' : 'unavailable',
          }
        })
        .filter(Boolean)

      res.json({
        therapistType,
        therapistId,
        range: {
          from: effectiveStart.toISOString(),
          to: endDate.toISOString(),
        },
        slots,
      })
    } catch (err) {
      console.error('Failed to load therapist availability:', err.message)
      res.status(500).json({ error: 'Failed to load therapist availability.' })
    }
  })

  // Book a therapist slot with row-level locking to avoid double bookings.
  app.post('/api/appointments', async (req, res) => {
    const studentId = parsePositiveInt(req.body?.studentId)
    const therapistType = normalizeTherapistType(req.body?.therapistType)
    const therapistId = parsePositiveInt(req.body?.therapistId)
    const availabilityId = parsePositiveInt(req.body?.availabilityId)
    const note = String(req.body?.note || '').slice(0, 500)

    if (!studentId || !therapistType || !therapistId || !availabilityId) {
      res.status(400).json({ error: 'studentId, therapistType, therapistId, and availabilityId are required.' })
      return
    }

    let client = null
    try {
      await ensureAppointmentSchema(dbPool)
      client = await dbPool.connect()
      await client.query('BEGIN')

      const availabilityResult = await client.query(
        `
        SELECT availability_id, start_at, end_at, is_available
        FROM therapist_availability
        WHERE availability_id = $1
          AND therapist_type = $2
          AND therapist_id = $3
        FOR UPDATE
        `,
        [availabilityId, therapistType, therapistId]
      )

      if (availabilityResult.rows.length === 0) {
        await client.query('ROLLBACK')
        res.status(404).json({ error: 'Selected slot was not found.' })
        return
      }

      const slot = availabilityResult.rows[0]
      if (!slot.is_available) {
        await client.query('ROLLBACK')
        res.status(409).json({ error: 'This slot is no longer available.' })
        return
      }

      const existingAppointment = await client.query(
        `
        SELECT appointment_id
        FROM appointments
        WHERE availability_id = $1
          AND status = 'booked'
        FOR UPDATE
        `,
        [availabilityId]
      )

      if (existingAppointment.rows.length > 0) {
        await client.query('ROLLBACK')
        res.status(409).json({ error: 'This slot has already been booked.' })
        return
      }

      const appointmentInsert = await client.query(
        `
        INSERT INTO appointments (
          student_id,
          therapist_type,
          therapist_id,
          availability_id,
          slot_start,
          slot_end,
          status,
          note
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'booked', $7)
        RETURNING appointment_id, slot_start, slot_end
        `,
        [studentId, therapistType, therapistId, availabilityId, slot.start_at, slot.end_at, note || null]
      )

      await client.query(
        `
        UPDATE therapist_availability
        SET is_available = FALSE,
            updated_at = NOW()
        WHERE availability_id = $1
        `,
        [availabilityId]
      )

      await client.query('COMMIT')

      const appointment = appointmentInsert.rows[0]
      res.status(201).json({
        appointmentId: Number(appointment.appointment_id),
        slotStart: toIsoString(appointment.slot_start),
        slotEnd: toIsoString(appointment.slot_end),
      })
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK')
        } catch (_) {}
      }
      console.error('Failed to book appointment:', err.message)
      res.status(500).json({ error: 'Failed to book appointment.' })
    } finally {
      if (client) client.release()
    }
  })

  // Return upcoming booked appointments for a therapist.
  app.get('/api/appointments/booked', async (req, res) => {
    try {
      const therapistType = normalizeTherapistType(req.query.therapistType)
      const therapistId = parsePositiveInt(req.query.therapistId)
      const days = Math.min(parsePositiveInt(req.query.days) || 30, 60)

      if (!therapistType || !therapistId) {
        return res.status(400).json({ error: 'therapistType and therapistId are required.' })
      }

      await ensureAppointmentSchema(dbPool)

      const start = new Date()
      const end = new Date(start)
      end.setUTCDate(end.getUTCDate() + days)

      const result = await dbPool.query(
        `
        SELECT
          a.appointment_id,
          a.student_id,
          COALESCE(NULLIF(s.username, ''), s.email, 'Student') AS student_name,
          a.slot_start,
          a.slot_end
        FROM appointments a
        INNER JOIN student s ON s.student_id = a.student_id
        WHERE a.therapist_type = $1
          AND a.therapist_id = $2
          AND a.status = 'booked'
          AND a.slot_start >= $3
          AND a.slot_start < $4
        ORDER BY a.slot_start ASC
        `,
        [therapistType, therapistId, start.toISOString(), end.toISOString()]
      )

      return res.json({
        appointments: result.rows.map((row) => ({
          appointmentId: Number(row.appointment_id),
          studentId: Number(row.student_id),
          studentName: String(row.student_name || 'Student'),
          slotStart: toIsoString(row.slot_start),
          slotEnd: toIsoString(row.slot_end),
        })),
      })
    } catch (err) {
      console.error('Failed to load booked appointments:', err.message)
      return res.status(500).json({ error: 'Failed to load booked appointments.' })
    }
  })
}

module.exports = { setupAppointmentsRoutes }


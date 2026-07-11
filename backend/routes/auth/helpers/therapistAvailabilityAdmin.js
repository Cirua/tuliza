async function updateTherapistDayAvailability({
  dbPool,
  ensureAppointmentSchema,
  normalizeTherapistType,
  resolveMentorWorkspaceId,
  resolvePsychiatristWorkspaceId,
  ensureGeneratedAvailabilitySlots,
  body,
  isAvailable,
}) {
  await ensureAppointmentSchema(dbPool)

  const therapistType = normalizeTherapistType(body?.therapistType)
  const dateInput = String(body?.date || '').trim()
  if (!therapistType) return { ok: false, status: 400, error: 'Valid therapistType is required.' }
  if (!dateInput) return { ok: false, status: 400, error: 'Valid date is required.' }

  let therapistId = null
  if (therapistType === 'mentor') {
    therapistId = await resolveMentorWorkspaceId(dbPool, body?.therapistId)
  } else {
    therapistId = await resolvePsychiatristWorkspaceId(dbPool, body?.therapistId)
  }

  if (!therapistId) return { ok: false, status: 404, error: 'Therapist profile not found.' }

  const dayStart = new Date(dateInput)
  if (Number.isNaN(dayStart.getTime())) return { ok: false, status: 400, error: 'Invalid date.' }
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)

  await ensureGeneratedAvailabilitySlots(dbPool, {
    therapistType,
    therapistId,
    startDate: dayStart,
    endDate: dayEnd,
  })

  const updated = await dbPool.query(
    `
    UPDATE therapist_availability ta
    SET is_available = ${isAvailable ? 'TRUE' : 'FALSE'},
        updated_at = NOW()
    WHERE ta.therapist_type = $1
      AND ta.therapist_id = $2
      AND ta.start_at >= $3
      AND ta.start_at < $4
      AND NOT EXISTS (
        SELECT 1
        FROM appointments a
        WHERE a.availability_id = ta.availability_id
          AND a.status = 'booked'
      )
    `,
    [therapistType, therapistId, dayStart.toISOString(), dayEnd.toISOString()]
  )

  return { ok: true, updatedSlots: Number(updated.rowCount || 0) }
}

module.exports = {
  updateTherapistDayAvailability,
}

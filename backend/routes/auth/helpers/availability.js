const { getWorkingWindowByDay } = require('../../../utils/appointmentTime')

// Lazily generate therapist availability slots for a requested date range.
async function ensureGeneratedAvailabilitySlots(dbPool, { therapistType, therapistId, startDate, endDate }) {
  const start = new Date(startDate)
  const end = new Date(endDate)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return

  const existing = await dbPool.query(
    `
    SELECT start_at, end_at
    FROM therapist_availability
    WHERE therapist_type = $1
      AND therapist_id = $2
      AND start_at >= $3
      AND start_at < $4
    `,
    [therapistType, therapistId, start.toISOString(), end.toISOString()]
  )

  const existingKeys = new Set(
    existing.rows.map((row) => `${new Date(row.start_at).toISOString()}|${new Date(row.end_at).toISOString()}`)
  )

  const insertValues = []
  const cursor = new Date(start)
  cursor.setHours(0, 0, 0, 0)

  while (cursor < end) {
    const window = getWorkingWindowByDay(cursor.getDay())
    if (window) {
      for (let hour = window.startHour; hour < window.endHour; hour += 1) {
        const slotStart = new Date(cursor)
        slotStart.setHours(hour, 0, 0, 0)
        const slotEnd = new Date(cursor)
        slotEnd.setHours(hour + 1, 0, 0, 0)

        if (slotStart < start || slotStart >= end) continue

        const key = `${slotStart.toISOString()}|${slotEnd.toISOString()}`
        if (existingKeys.has(key)) continue

        insertValues.push({
          startAt: slotStart.toISOString(),
          endAt: slotEnd.toISOString(),
        })
      }
    }

    cursor.setDate(cursor.getDate() + 1)
  }

  if (!insertValues.length) return

  const placeholders = []
  const params = []
  insertValues.forEach((slot, index) => {
    const paramOffset = index * 4
    placeholders.push(
      `($${paramOffset + 1}, $${paramOffset + 2}, $${paramOffset + 3}, $${paramOffset + 4}, TRUE, NOW(), NOW())`
    )
    params.push(therapistType, therapistId, slot.startAt, slot.endAt)
  })

  await dbPool.query(
    `
    INSERT INTO therapist_availability (
      therapist_type,
      therapist_id,
      start_at,
      end_at,
      is_available,
      created_at,
      updated_at
    )
    VALUES ${placeholders.join(', ')}
    `,
    params
  )
}

module.exports = { ensureGeneratedAvailabilitySlots }


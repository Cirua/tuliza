const { dbPool } = require('./pool')
const { toIsoString } = require('../config')

function parseStoredMessage(rawValue) {
  const fallbackText = String(rawValue || '').trim()
  if (!fallbackText) return null

  try {
    const parsed = JSON.parse(fallbackText)
    if (!parsed || typeof parsed !== 'object') {
      return { text: fallbackText, senderRole: null, senderId: null }
    }

    const text = String(parsed.text || '').trim()
    if (!text) return null

    return {
      text,
      senderRole: parsed.senderRole ? String(parsed.senderRole) : null,
      senderId: parsed.senderId != null ? String(parsed.senderId) : null,
    }
  } catch (_) {
    return { text: fallbackText, senderRole: null, senderId: null }
  }
}

async function getDisplayNameByRoleAndId(role, userId) {
  const numericId = Number(userId)
  if (!Number.isInteger(numericId) || numericId <= 0) return String(userId || '')

  if (role === 'student') {
    const result = await dbPool.query('SELECT username FROM student WHERE student_id = $1 LIMIT 1', [numericId])
    return result.rows[0] ? String(result.rows[0].username || numericId) : String(numericId)
  }

  if (role === 'mentor') {
    const result = await dbPool.query('SELECT full_name FROM mentor WHERE mentor_id = $1 LIMIT 1', [numericId])
    return result.rows[0] ? String(result.rows[0].full_name || numericId) : String(numericId)
  }

  if (role === 'psychiatrist') {
    const result = await dbPool.query('SELECT full_name FROM psychiatrist WHERE psychiatrist_id = $1 LIMIT 1', [numericId])
    return result.rows[0] ? String(result.rows[0].full_name || numericId) : String(numericId)
  }

  return String(userId || '')
}

async function loadConversationHistory(context, limit = 100) {
  if (!context.peerUserId || !context.peerRole) return []

  const params = [Number(context.userId), Number(context.peerUserId), Number(limit)]
  let sql

  if (context.role === 'student' && context.peerRole === 'mentor') {
    sql = `
      SELECT message_id, encrypted_message, sent_at, student_id, mentor_id, psychiatrist_id
      FROM (
        SELECT message_id, encrypted_message, sent_at, student_id, mentor_id, psychiatrist_id
        FROM messages
        WHERE student_id = $1 AND mentor_id = $2
        ORDER BY sent_at DESC NULLS LAST, message_id DESC
        LIMIT $3
      ) latest
      ORDER BY sent_at ASC NULLS FIRST, message_id ASC
    `
  } else if (context.role === 'student' && context.peerRole === 'psychiatrist') {
    sql = `
      SELECT message_id, encrypted_message, sent_at, student_id, mentor_id, psychiatrist_id
      FROM (
        SELECT message_id, encrypted_message, sent_at, student_id, mentor_id, psychiatrist_id
        FROM messages
        WHERE student_id = $1 AND psychiatrist_id = $2
        ORDER BY sent_at DESC NULLS LAST, message_id DESC
        LIMIT $3
      ) latest
      ORDER BY sent_at ASC NULLS FIRST, message_id ASC
    `
  } else if (context.role === 'mentor' && context.peerRole === 'student') {
    sql = `
      SELECT message_id, encrypted_message, sent_at, student_id, mentor_id, psychiatrist_id
      FROM (
        SELECT message_id, encrypted_message, sent_at, student_id, mentor_id, psychiatrist_id
        FROM messages
        WHERE mentor_id = $1 AND student_id = $2
        ORDER BY sent_at DESC NULLS LAST, message_id DESC
        LIMIT $3
      ) latest
      ORDER BY sent_at ASC NULLS FIRST, message_id ASC
    `
  } else {
    sql = `
      SELECT message_id, encrypted_message, sent_at, student_id, mentor_id, psychiatrist_id
      FROM (
        SELECT message_id, encrypted_message, sent_at, student_id, mentor_id, psychiatrist_id
        FROM messages
        WHERE psychiatrist_id = $1 AND student_id = $2
        ORDER BY sent_at DESC NULLS LAST, message_id DESC
        LIMIT $3
      ) latest
      ORDER BY sent_at ASC NULLS FIRST, message_id ASC
    `
  }

  const result = await dbPool.query(sql, params)

  const displayNameCache = new Map()

  const historyRows = await Promise.all(
    result.rows.map(async (row) => {
      const parsed = parseStoredMessage(row.encrypted_message)
      if (!parsed) return null

      let fromRole = parsed.senderRole
      let sender = parsed.senderId

      if (!fromRole) {
        fromRole = context.role === 'student' ? context.peerRole : 'student'
      }

      if (!sender) {
        if (fromRole === 'student') sender = row.student_id != null ? String(row.student_id) : ''
        if (fromRole === 'mentor') sender = row.mentor_id != null ? String(row.mentor_id) : ''
        if (fromRole === 'psychiatrist') sender = row.psychiatrist_id != null ? String(row.psychiatrist_id) : ''
      }

      const cacheKey = `${fromRole}:${sender}`
      let senderName = displayNameCache.get(cacheKey)
      if (!senderName) {
        senderName = await getDisplayNameByRoleAndId(fromRole, sender)
        displayNameCache.set(cacheKey, senderName)
      }

      return {
        type: 'message',
        messageId: String(row.message_id),
        sender,
        senderName,
        text: parsed.text,
        timestamp: row.sent_at ? toIsoString(row.sent_at) : null,
        fromRole,
        threadStudentId: row.student_id != null ? String(row.student_id) : null,
      }
    })
  )

  return historyRows.filter(Boolean)
}

async function persistMessage(context, text) {
  const studentId = context.role === 'student' ? Number(context.userId) : Number(context.peerUserId)
  const mentorId =
    context.role === 'mentor' ? Number(context.userId) : context.peerRole === 'mentor' ? Number(context.peerUserId) : null
  const psychiatristId =
    context.role === 'psychiatrist'
      ? Number(context.userId)
      : context.peerRole === 'psychiatrist'
        ? Number(context.peerUserId)
        : null

  const messagePayload = JSON.stringify({
    text: String(text),
    senderRole: String(context.role),
    senderId: String(context.userId),
  })

  const result = await dbPool.query(
    `
    INSERT INTO messages (encrypted_message, sent_at, student_id, mentor_id, psychiatrist_id)
    VALUES ($1, NOW(), $2, $3, $4)
    RETURNING message_id, sent_at
    `,
    [messagePayload, studentId, mentorId, psychiatristId]
  )

  return result.rows[0]
}

module.exports = {
  loadConversationHistory,
  persistMessage,
}


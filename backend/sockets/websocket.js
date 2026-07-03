const WebSocket = require('ws')

const { resolveParticipantContext } = require('../db/chatContext')
const { loadConversationHistory, persistMessage } = require('../db/messages')
const { deliverToUser, addSocketForUser, removeSocketForUser } = require('./users')
const { toIsoString, roleLabel } = require('../config')
const { verifySessionToken } = require('../auth/sessionToken')


function setupWebSocket(server, { isAllowedOrigin }) {
  const wss = new WebSocket.Server({
    server,
    verifyClient: (info, done) => {
      const origin = info.origin || info.req.headers.origin
      const path = info.req.url || ''
      if (!path.startsWith('/server')) {
        done(false, 404, 'Invalid websocket path')
        return
      }

      if (!isAllowedOrigin(origin)) {
        done(false, 403, 'Forbidden origin')
        return
      }

      done(true)
    },
  })

  wss.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') {
      console.error('WebSocket server error:', err.message)
    }
  })

  function sendWsError(ws, reason) {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(
      JSON.stringify({
        type: 'error',
        reason,
      })
    )
  }

  wss.on('connection', (ws) => {
    ws.userContext = null
    ws.isAuthorized = false

    ws.on('error', (err) => {
      console.warn('WebSocket client error:', err.message)
    })

    ws.on('message', async (message) => {
      let messageObject
      try {
        messageObject = JSON.parse(message.toString())
      } catch (_) {
        return
      }

      const { type } = messageObject

      if (type === 'join') {
        const { userId, roleHint, peerUserId, peerRole, authToken } = messageObject
        if (!userId) return

        const expectedToken = process.env.TULIZA_WS_TOKEN
        const hasStaticToken = Boolean(expectedToken)
        const hasSessionSecret = Boolean(process.env.TULIZA_SESSION_SECRET)
        let sessionClaims = null
        if (hasStaticToken || (hasSessionSecret && authToken)) {
          const staticTokenOk = hasStaticToken && authToken === expectedToken
          if (!staticTokenOk) {
            sessionClaims = verifySessionToken(authToken)
          }

          if (!staticTokenOk && !sessionClaims) {
            ws.close(1008, 'Unauthorized')
            return
          }
        }

        let context
        try {
          context = await resolveParticipantContext(String(userId), roleHint, peerUserId, peerRole)
        } catch (err) {
          console.error('Failed to resolve chat context:', err.message)
          sendWsError(ws, `Failed to resolve user context: ${err.message}`)
          ws.close(1011, 'Failed to resolve user context')
          return
        }

        if (!context) {
          ws.close(1008, 'Unknown user ID or role')
          return
        }

        if (sessionClaims) {
          const directMatch =
            String(sessionClaims.userId) === String(context.userId) && String(sessionClaims.role) === String(context.role)

          if (!directMatch) {
            let claimContext = null
            try {
              claimContext = await resolveParticipantContext(
                String(sessionClaims.userId),
                String(sessionClaims.role),
                peerUserId,
                peerRole
              )
            } catch (_) {
              claimContext = null
            }

            const compatibleIdentity =
              claimContext &&
              String(claimContext.userId) === String(context.userId) &&
              String(claimContext.role) === String(context.role)

            if (!compatibleIdentity) {
              ws.close(1008, 'Unauthorized identity')
              return
            }
          }
        }

        if (ws.userContext) {
          removeSocketForUser(ws.userContext.role, ws.userContext.userId, ws)
        }

        ws.isAuthorized = true
        ws.userContext = context
        addSocketForUser(context.role, context.userId, ws)

        ws.send(
          JSON.stringify({
            type: 'joined',
            userId: context.userId,
            displayName: context.displayName,
            role: context.role,
            peerUserId: context.peerUserId,
            peerRole: context.peerRole,
            peerDisplayName: context.peerDisplayName,
          })
        )

        try {
          const history = await loadConversationHistory(context)
          ws.send(
            JSON.stringify({
              type: 'history',
              messages: history,
            })
          )
        } catch (err) {
          console.warn('Failed to load message history:', err.message)
        }

        return
      }

      if (!ws.isAuthorized || !ws.userContext) return
      if (type !== 'message') return

      const { sender, text } = messageObject
      if (!sender || !text) return
      if (String(sender) !== String(ws.userContext.userId)) return
      if (!ws.userContext.peerUserId || !ws.userContext.peerRole) {
        sendWsError(ws, 'No active counterpart found for this user ID.')
        return
      }

      let stored
      try {
        stored = await persistMessage(ws.userContext, String(text))
      } catch (err) {
        console.warn('Failed to store message:', err.message)
        sendWsError(ws, 'Message could not be saved to the database.')
        return
      }

      const outboundMessage = {
        type: 'message',
        messageId: String(stored.message_id),
        sender: String(sender),
        senderName: String(ws.userContext.displayName || sender),
        text: String(text),
        timestamp: toIsoString(stored.sent_at),
        fromRole: ws.userContext.role,
        toRole: ws.userContext.peerRole,
        fromRoleLabel: roleLabel(ws.userContext.role),
        toRoleLabel: roleLabel(ws.userContext.peerRole),
        toUserId: String(ws.userContext.peerUserId),
        threadStudentId:
          ws.userContext.role === 'student' ? String(ws.userContext.userId) : String(ws.userContext.peerUserId),
      }

      deliverToUser(ws.userContext.role, ws.userContext.userId, outboundMessage)
      deliverToUser(ws.userContext.peerRole, ws.userContext.peerUserId, outboundMessage)
    })

    ws.on('close', () => {
      const ctx = ws.userContext
      if (!ctx) return
      removeSocketForUser(ctx.role, ctx.userId, ws)
    })
  })

  return wss
}

module.exports = { setupWebSocket }


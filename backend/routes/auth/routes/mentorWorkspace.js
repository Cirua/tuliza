function setupMentorWorkspaceRoutes(app, dbPool, deps) {
  const { ensureMentorWorkspaceSchema, resolveMentorWorkspaceId, parsePositiveInt, toIsoString } = deps

  // Mentor notes CRUD endpoints.
  app.get('/api/mentor/notes', async (req, res) => {
    try {
      await ensureMentorWorkspaceSchema(dbPool)

      const mentorId = await resolveMentorWorkspaceId(dbPool, req.query.mentorId)
      if (!mentorId) {
        return res.status(404).json({ error: 'Mentor profile not found. Complete mentor profile setup first.' })
      }

      const result = await dbPool.query(
        `
        SELECT note_id, mentor_id, note_text, created_at, updated_at
        FROM mentor_notes
        WHERE mentor_id = $1
        ORDER BY updated_at DESC, note_id DESC
        `,
        [mentorId]
      )

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          noteId: Number(row.note_id),
          mentorId: Number(row.mentor_id),
          noteText: String(row.note_text || ''),
          createdAt: toIsoString(row.created_at),
          updatedAt: toIsoString(row.updated_at),
        })),
      })
    } catch (err) {
      console.error('Failed to load mentor notes:', err.message)
      return res.status(500).json({ error: 'Failed to load mentor notes.' })
    }
  })

  app.post('/api/mentor/notes', async (req, res) => {
    try {
      await ensureMentorWorkspaceSchema(dbPool)

      const mentorId = await resolveMentorWorkspaceId(dbPool, req.body?.mentorId)
      const noteText = String(req.body?.noteText || '').trim().slice(0, 5000)

      if (!mentorId) {
        return res.status(404).json({ error: 'Mentor profile not found. Complete mentor profile setup first.' })
      }
      if (!noteText) return res.status(400).json({ error: 'Note text is required.' })

      const inserted = await dbPool.query(
        `
        INSERT INTO mentor_notes (mentor_id, note_text, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        RETURNING note_id
        `,
        [mentorId, noteText]
      )

      return res.status(201).json({ ok: true, noteId: Number(inserted.rows[0].note_id) })
    } catch (err) {
      console.error('Failed to create mentor note:', err.message)
      return res.status(500).json({ error: 'Failed to create mentor note.' })
    }
  })

  app.put('/api/mentor/notes/:noteId', async (req, res) => {
    try {
      await ensureMentorWorkspaceSchema(dbPool)

      const noteId = parsePositiveInt(req.params.noteId)
      const mentorId = await resolveMentorWorkspaceId(dbPool, req.body?.mentorId)
      const noteText = String(req.body?.noteText || '').trim().slice(0, 5000)

      if (!noteId) return res.status(400).json({ error: 'Valid noteId is required.' })
      if (!mentorId) {
        return res.status(404).json({ error: 'Mentor profile not found. Complete mentor profile setup first.' })
      }
      if (!noteText) return res.status(400).json({ error: 'Note text is required.' })

      const updated = await dbPool.query(
        `
        UPDATE mentor_notes
        SET note_text = $1,
            updated_at = NOW()
        WHERE note_id = $2 AND mentor_id = $3
        RETURNING note_id
        `,
        [noteText, noteId, mentorId]
      )

      if (!updated.rows[0]) return res.status(404).json({ error: 'Note not found.' })
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to update mentor note:', err.message)
      return res.status(500).json({ error: 'Failed to update mentor note.' })
    }
  })

  app.delete('/api/mentor/notes/:noteId', async (req, res) => {
    try {
      await ensureMentorWorkspaceSchema(dbPool)

      const noteId = parsePositiveInt(req.params.noteId)
      const mentorId = await resolveMentorWorkspaceId(dbPool, req.query.mentorId)

      if (!noteId) return res.status(400).json({ error: 'Valid noteId is required.' })
      if (!mentorId) {
        return res.status(404).json({ error: 'Mentor profile not found. Complete mentor profile setup first.' })
      }

      const deleted = await dbPool.query('DELETE FROM mentor_notes WHERE note_id = $1 AND mentor_id = $2 RETURNING note_id', [
        noteId,
        mentorId,
      ])

      if (!deleted.rows[0]) return res.status(404).json({ error: 'Note not found.' })
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to delete mentor note:', err.message)
      return res.status(500).json({ error: 'Failed to delete mentor note.' })
    }
  })

  // Mentor checklist CRUD endpoints.
  app.get('/api/mentor/checklist', async (req, res) => {
    try {
      await ensureMentorWorkspaceSchema(dbPool)

      const mentorId = await resolveMentorWorkspaceId(dbPool, req.query.mentorId)
      if (!mentorId) {
        return res.status(404).json({ error: 'Mentor profile not found. Complete mentor profile setup first.' })
      }

      const result = await dbPool.query(
        `
        SELECT item_id, mentor_id, item_text, is_done, created_at, updated_at
        FROM mentor_checklist
        WHERE mentor_id = $1
        ORDER BY is_done ASC, updated_at DESC, item_id DESC
        `,
        [mentorId]
      )

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          itemId: Number(row.item_id),
          mentorId: Number(row.mentor_id),
          itemText: String(row.item_text || ''),
          isDone: Boolean(row.is_done),
          createdAt: toIsoString(row.created_at),
          updatedAt: toIsoString(row.updated_at),
        })),
      })
    } catch (err) {
      console.error('Failed to load mentor checklist:', err.message)
      return res.status(500).json({ error: 'Failed to load mentor checklist.' })
    }
  })

  app.post('/api/mentor/checklist', async (req, res) => {
    try {
      await ensureMentorWorkspaceSchema(dbPool)

      const mentorId = await resolveMentorWorkspaceId(dbPool, req.body?.mentorId)
      const itemText = String(req.body?.itemText || '').trim().slice(0, 500)

      if (!mentorId) {
        return res.status(404).json({ error: 'Mentor profile not found. Complete mentor profile setup first.' })
      }
      if (!itemText) return res.status(400).json({ error: 'Checklist item text is required.' })

      const inserted = await dbPool.query(
        `
        INSERT INTO mentor_checklist (mentor_id, item_text, is_done, created_at, updated_at)
        VALUES ($1, $2, FALSE, NOW(), NOW())
        RETURNING item_id
        `,
        [mentorId, itemText]
      )

      return res.status(201).json({ ok: true, itemId: Number(inserted.rows[0].item_id) })
    } catch (err) {
      console.error('Failed to create checklist item:', err.message)
      return res.status(500).json({ error: 'Failed to create checklist item.' })
    }
  })

  app.put('/api/mentor/checklist/:itemId', async (req, res) => {
    try {
      await ensureMentorWorkspaceSchema(dbPool)

      const itemId = parsePositiveInt(req.params.itemId)
      const mentorId = await resolveMentorWorkspaceId(dbPool, req.body?.mentorId)
      const itemText = String(req.body?.itemText || '').trim().slice(0, 500)
      const isDone = typeof req.body?.isDone === 'boolean' ? req.body.isDone : null

      if (!itemId) return res.status(400).json({ error: 'Valid itemId is required.' })
      if (!mentorId) {
        return res.status(404).json({ error: 'Mentor profile not found. Complete mentor profile setup first.' })
      }
      if (!itemText) return res.status(400).json({ error: 'Checklist item text is required.' })
      if (isDone === null) return res.status(400).json({ error: 'isDone must be a boolean.' })

      const updated = await dbPool.query(
        `
        UPDATE mentor_checklist
        SET item_text = $1,
            is_done = $2,
            updated_at = NOW()
        WHERE item_id = $3 AND mentor_id = $4
        RETURNING item_id
        `,
        [itemText, isDone, itemId, mentorId]
      )

      if (!updated.rows[0]) return res.status(404).json({ error: 'Checklist item not found.' })
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to update checklist item:', err.message)
      return res.status(500).json({ error: 'Failed to update checklist item.' })
    }
  })

  app.delete('/api/mentor/checklist/:itemId', async (req, res) => {
    try {
      await ensureMentorWorkspaceSchema(dbPool)

      const itemId = parsePositiveInt(req.params.itemId)
      const mentorId = await resolveMentorWorkspaceId(dbPool, req.query.mentorId)

      if (!itemId) return res.status(400).json({ error: 'Valid itemId is required.' })
      if (!mentorId) {
        return res.status(404).json({ error: 'Mentor profile not found. Complete mentor profile setup first.' })
      }

      const deleted = await dbPool.query(
        'DELETE FROM mentor_checklist WHERE item_id = $1 AND mentor_id = $2 RETURNING item_id',
        [itemId, mentorId]
      )

      if (!deleted.rows[0]) return res.status(404).json({ error: 'Checklist item not found.' })
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to delete checklist item:', err.message)
      return res.status(500).json({ error: 'Failed to delete checklist item.' })
    }
  })
}

module.exports = { setupMentorWorkspaceRoutes }

function setupPsychiatristWorkspaceRoutes(app, dbPool, deps) {
  const { ensurePsychiatristWorkspaceSchema, resolvePsychiatristWorkspaceId, parsePositiveInt, toIsoString } = deps

  // Psychiatrist notes CRUD endpoints.
  app.get('/api/psychiatrist/notes', async (req, res) => {
    try {
      await ensurePsychiatristWorkspaceSchema(dbPool)

      const psychiatristId = await resolvePsychiatristWorkspaceId(dbPool, req.query.psychiatristId)
      if (!psychiatristId) {
        return res.status(404).json({ error: 'Psychiatrist profile not found. Complete psychiatrist profile setup first.' })
      }

      const result = await dbPool.query(
        `
        SELECT note_id, psychiatrist_id, note_text, created_at, updated_at
        FROM psychiatrist_notes
        WHERE psychiatrist_id = $1
        ORDER BY updated_at DESC, note_id DESC
        `,
        [psychiatristId]
      )

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          noteId: Number(row.note_id),
          psychiatristId: Number(row.psychiatrist_id),
          noteText: String(row.note_text || ''),
          createdAt: toIsoString(row.created_at),
          updatedAt: toIsoString(row.updated_at),
        })),
      })
    } catch (err) {
      console.error('Failed to load psychiatrist notes:', err.message)
      return res.status(500).json({ error: 'Failed to load psychiatrist notes.' })
    }
  })

  app.post('/api/psychiatrist/notes', async (req, res) => {
    try {
      await ensurePsychiatristWorkspaceSchema(dbPool)

      const psychiatristId = await resolvePsychiatristWorkspaceId(dbPool, req.body?.psychiatristId)
      const noteText = String(req.body?.noteText || '').trim().slice(0, 5000)

      if (!psychiatristId) {
        return res.status(404).json({ error: 'Psychiatrist profile not found. Complete psychiatrist profile setup first.' })
      }
      if (!noteText) return res.status(400).json({ error: 'Note text is required.' })

      const inserted = await dbPool.query(
        `
        INSERT INTO psychiatrist_notes (psychiatrist_id, note_text, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        RETURNING note_id
        `,
        [psychiatristId, noteText]
      )

      return res.status(201).json({ ok: true, noteId: Number(inserted.rows[0].note_id) })
    } catch (err) {
      console.error('Failed to create psychiatrist note:', err.message)
      return res.status(500).json({ error: 'Failed to create psychiatrist note.' })
    }
  })

  app.put('/api/psychiatrist/notes/:noteId', async (req, res) => {
    try {
      await ensurePsychiatristWorkspaceSchema(dbPool)

      const noteId = parsePositiveInt(req.params.noteId)
      const psychiatristId = await resolvePsychiatristWorkspaceId(dbPool, req.body?.psychiatristId)
      const noteText = String(req.body?.noteText || '').trim().slice(0, 5000)

      if (!noteId) return res.status(400).json({ error: 'Valid noteId is required.' })
      if (!psychiatristId) {
        return res.status(404).json({ error: 'Psychiatrist profile not found. Complete psychiatrist profile setup first.' })
      }
      if (!noteText) return res.status(400).json({ error: 'Note text is required.' })

      const updated = await dbPool.query(
        `
        UPDATE psychiatrist_notes
        SET note_text = $1,
            updated_at = NOW()
        WHERE note_id = $2 AND psychiatrist_id = $3
        RETURNING note_id
        `,
        [noteText, noteId, psychiatristId]
      )

      if (!updated.rows[0]) return res.status(404).json({ error: 'Note not found.' })
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to update psychiatrist note:', err.message)
      return res.status(500).json({ error: 'Failed to update psychiatrist note.' })
    }
  })

  app.delete('/api/psychiatrist/notes/:noteId', async (req, res) => {
    try {
      await ensurePsychiatristWorkspaceSchema(dbPool)

      const noteId = parsePositiveInt(req.params.noteId)
      const psychiatristId = await resolvePsychiatristWorkspaceId(dbPool, req.query.psychiatristId)

      if (!noteId) return res.status(400).json({ error: 'Valid noteId is required.' })
      if (!psychiatristId) {
        return res.status(404).json({ error: 'Psychiatrist profile not found. Complete psychiatrist profile setup first.' })
      }

      const deleted = await dbPool.query(
        'DELETE FROM psychiatrist_notes WHERE note_id = $1 AND psychiatrist_id = $2 RETURNING note_id',
        [noteId, psychiatristId]
      )

      if (!deleted.rows[0]) return res.status(404).json({ error: 'Note not found.' })
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to delete psychiatrist note:', err.message)
      return res.status(500).json({ error: 'Failed to delete psychiatrist note.' })
    }
  })

  // Psychiatrist risk overview CRUD endpoints.
  app.get('/api/psychiatrist/risk-overview', async (req, res) => {
    try {
      await ensurePsychiatristWorkspaceSchema(dbPool)

      const psychiatristId = await resolvePsychiatristWorkspaceId(dbPool, req.query.psychiatristId)
      if (!psychiatristId) {
        return res.status(404).json({ error: 'Psychiatrist profile not found. Complete psychiatrist profile setup first.' })
      }

      const result = await dbPool.query(
        `
        SELECT risk_id, psychiatrist_id, item_text, created_at, updated_at
        FROM psychiatrist_risk_overview
        WHERE psychiatrist_id = $1
        ORDER BY updated_at DESC, risk_id DESC
        `,
        [psychiatristId]
      )

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          riskId: Number(row.risk_id),
          psychiatristId: Number(row.psychiatrist_id),
          itemText: String(row.item_text || ''),
          createdAt: toIsoString(row.created_at),
          updatedAt: toIsoString(row.updated_at),
        })),
      })
    } catch (err) {
      console.error('Failed to load psychiatrist risk overview:', err.message)
      return res.status(500).json({ error: 'Failed to load risk overview.' })
    }
  })

  app.post('/api/psychiatrist/risk-overview', async (req, res) => {
    try {
      await ensurePsychiatristWorkspaceSchema(dbPool)

      const psychiatristId = await resolvePsychiatristWorkspaceId(dbPool, req.body?.psychiatristId)
      const itemText = String(req.body?.itemText || '').trim().slice(0, 500)

      if (!psychiatristId) {
        return res.status(404).json({ error: 'Psychiatrist profile not found. Complete psychiatrist profile setup first.' })
      }
      if (!itemText) return res.status(400).json({ error: 'Risk item text is required.' })

      const inserted = await dbPool.query(
        `
        INSERT INTO psychiatrist_risk_overview (psychiatrist_id, item_text, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        RETURNING risk_id
        `,
        [psychiatristId, itemText]
      )

      return res.status(201).json({ ok: true, riskId: Number(inserted.rows[0].risk_id) })
    } catch (err) {
      console.error('Failed to create psychiatrist risk item:', err.message)
      return res.status(500).json({ error: 'Failed to create risk item.' })
    }
  })

  app.put('/api/psychiatrist/risk-overview/:riskId', async (req, res) => {
    try {
      await ensurePsychiatristWorkspaceSchema(dbPool)

      const riskId = parsePositiveInt(req.params.riskId)
      const psychiatristId = await resolvePsychiatristWorkspaceId(dbPool, req.body?.psychiatristId)
      const itemText = String(req.body?.itemText || '').trim().slice(0, 500)

      if (!riskId) return res.status(400).json({ error: 'Valid riskId is required.' })
      if (!psychiatristId) {
        return res.status(404).json({ error: 'Psychiatrist profile not found. Complete psychiatrist profile setup first.' })
      }
      if (!itemText) return res.status(400).json({ error: 'Risk item text is required.' })

      const updated = await dbPool.query(
        `
        UPDATE psychiatrist_risk_overview
        SET item_text = $1,
            updated_at = NOW()
        WHERE risk_id = $2 AND psychiatrist_id = $3
        RETURNING risk_id
        `,
        [itemText, riskId, psychiatristId]
      )

      if (!updated.rows[0]) return res.status(404).json({ error: 'Risk item not found.' })
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to update psychiatrist risk item:', err.message)
      return res.status(500).json({ error: 'Failed to update risk item.' })
    }
  })

  app.delete('/api/psychiatrist/risk-overview/:riskId', async (req, res) => {
    try {
      await ensurePsychiatristWorkspaceSchema(dbPool)

      const riskId = parsePositiveInt(req.params.riskId)
      const psychiatristId = await resolvePsychiatristWorkspaceId(dbPool, req.query.psychiatristId)

      if (!riskId) return res.status(400).json({ error: 'Valid riskId is required.' })
      if (!psychiatristId) {
        return res.status(404).json({ error: 'Psychiatrist profile not found. Complete psychiatrist profile setup first.' })
      }

      const deleted = await dbPool.query(
        'DELETE FROM psychiatrist_risk_overview WHERE risk_id = $1 AND psychiatrist_id = $2 RETURNING risk_id',
        [riskId, psychiatristId]
      )

      if (!deleted.rows[0]) return res.status(404).json({ error: 'Risk item not found.' })
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to delete psychiatrist risk item:', err.message)
      return res.status(500).json({ error: 'Failed to delete risk item.' })
    }
  })
}

module.exports = { setupPsychiatristWorkspaceRoutes }

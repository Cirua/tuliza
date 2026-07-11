// Check if a table exists in the public schema.
async function tableExists(db, tableName) {
  const result = await db.query('SELECT to_regclass($1) AS reg', [`public.${String(tableName || '').trim()}`])
  return Boolean(result.rows[0] && result.rows[0].reg)
}

// Check if a specific column exists on a table.
async function tableHasColumn(db, tableName, columnName) {
  const result = await db.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
    ) AS exists
    `,
    [String(tableName || '').trim(), String(columnName || '').trim()]
  )
  return Boolean(result.rows[0] && result.rows[0].exists)
}

module.exports = {
  tableExists,
  tableHasColumn,
}

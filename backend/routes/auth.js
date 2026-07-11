// Auth route orchestrator (module-based)
const bcrypt = require('bcrypt')
const { sanitizeRole, roleToTable } = require('../config')
const { createSessionToken } = require('../auth/sessionToken')
const { roleIdColumn, dashboardPath, profilePath } = require('../utils/roleHelpers')
const { tableExists, tableHasColumn } = require('../utils/schemaGuards')
const {
  normalizeTherapistType,
  toUtcDateFloor,
  toIsoString,
  isWithinWorkingHours,
  getWorkingWindowByDay,
} = require('../utils/appointmentTime')
const {
  isStrongPassword,
  parsePositiveInt,
  parseNullablePhone,
  parseNonNegativeInt,
} = require('../utils/inputParsers')
const {
  createStaffAccount,
  updateStaffAccountBySignupId,
  deleteStaffAccountBySignupId,
} = require('./auth/helpers/staffAccounts')
const { updateTherapistDayAvailability } = require('./auth/helpers/therapistAvailabilityAdmin')
const { setupMentorWorkspaceRoutes } = require('./auth/routes/mentorWorkspace')
const { setupMentorAvailabilityRoutes } = require('./auth/routes/mentorAvailability')
const { setupPsychiatristWorkspaceRoutes } = require('./auth/routes/psychiatristWorkspace')
const { setupPsychiatristAvailabilityReportRoutes } = require('./auth/routes/psychiatristAvailabilityReport')

const { setupAuthRoutesFromModules } = require('./auth/routes/index')

// Re-exported API: setupAuthRoutes(app, dbPool)
function setupAuthRoutes(app, dbPool) {
  setupAuthRoutesFromModules(app, dbPool, {
    // shared deps for extracted routes
    bcrypt,
    sanitizeRole,
    roleToTable,
    resolveRoleRow,
    resolveOrRepairRoleProfileRow,
    createSessionToken,
    profilePath,
    dashboardPath,
    buildStudentUsername,
    ensurePasswordHashColumn,
    ensureRoleProfileRow,
    resolveStudentIdForQuestionnaire,
    ensureQuestionnaireWriteSchema,
    normalizeTherapistType,
    toUtcDateFloor,
    toIsoString,
    ensureAppointmentSchema,
    ensureGeneratedAvailabilitySlots,
    isWithinWorkingHours,
    getWorkingWindowByDay,
    ensureMentorWorkspaceSchema,
    ensurePsychiatristWorkspaceSchema,
    resolvePsychiatristTableMeta,
    ensureStudentIdAutoIncrement,
    ensureMentorIdAutoIncrement,
    ensurePsychiatristIdAutoIncrement,
    resolveMentorWorkspaceId,
    resolvePsychiatristWorkspaceId,
    ensureJournalSchema,
    isStrongPassword,
    parsePositiveInt,
    parseNullablePhone,
    parseNonNegativeInt,
    tableExists,
    tableHasColumn,
    roleIdColumn,
  })

  // Keep remaining legacy endpoints active until fully extracted.
  setupLegacyAuthRoutes(app, dbPool)
}

module.exports = { setupAuthRoutes }

/*
  NOTE:
  This file was previously monolithic. It has been replaced by a thin orchestrator that delegates
  to the module-based route setup under backend/routes/auth/routes/*.
*/


// Generate a compact, unique username seed for newly created students.
function buildStudentUsername(email) {
  const localPart = String(email || '').split('@')[0] || 'student'
  const base = localPart.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'student'
  const suffix = Date.now().toString().slice(-6)
  return `${base}_${suffix}`
}

// Resolve the active psychiatrist table shape for schema-compatible queries.
async function resolvePsychiatristTableMeta(db) {
  const candidates = [
    { table: 'psychiatrist', idColumn: 'psychiatrist_id' },
    { table: 'psychiatrists', idColumn: 'psychiatrist_id' },
    { table: 'psychiatrists', idColumn: 'psychiatrists_id' },
  ]

  for (const candidate of candidates) {
    const exists = await tableExists(db, candidate.table)
    if (!exists) continue

    const hasIdColumn = await tableHasColumn(db, candidate.table, candidate.idColumn)
    if (!hasIdColumn) continue

    const hasSignupColumn = await tableHasColumn(db, candidate.table, 'signup_id')
    return {
      table: candidate.table,
      idColumn: candidate.idColumn,
      hasSignupColumn,
    }
  }

  return null
}

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
    placeholders.push(`($${paramOffset + 1}, $${paramOffset + 2}, $${paramOffset + 3}, $${paramOffset + 4}, TRUE, NOW(), NOW())`)
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

// Create and index appointment-related tables if they are missing.
async function ensureAppointmentSchema(dbPool) {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS therapist_availability (
      availability_id SERIAL PRIMARY KEY,
      therapist_type VARCHAR(30) NOT NULL,
      therapist_id INT NOT NULL,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      is_available BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      appointment_id SERIAL PRIMARY KEY,
      student_id INT NOT NULL REFERENCES student(student_id) ON DELETE CASCADE,
      therapist_type VARCHAR(30) NOT NULL,
      therapist_id INT NOT NULL,
      availability_id INT NOT NULL REFERENCES therapist_availability(availability_id) ON DELETE CASCADE,
      slot_start TIMESTAMPTZ NOT NULL,
      slot_end TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'booked',
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await dbPool.query('CREATE INDEX IF NOT EXISTS idx_therapist_availability_lookup ON therapist_availability(therapist_type, therapist_id, start_at)')
  await dbPool.query('CREATE INDEX IF NOT EXISTS idx_appointments_lookup ON appointments(therapist_type, therapist_id, slot_start)')
  await dbPool.query('CREATE INDEX IF NOT EXISTS idx_appointments_availability ON appointments(availability_id)')
}

// Create and index journal table used by student journals.
async function ensureJournalSchema(dbPool) {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS journal (
      journal_id SERIAL PRIMARY KEY,
      student_id INT NOT NULL REFERENCES student(student_id) ON DELETE CASCADE,
      title VARCHAR(255),
      journal_entry TEXT NOT NULL,
      mood VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)

  await dbPool.query('CREATE INDEX IF NOT EXISTS idx_journal_student_created ON journal(student_id, created_at DESC)')
}

// Create and evolve admin-facing data tables used by dashboard operations.
async function ensureAdminOpsSchema(dbPool) {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      admin_id SERIAL PRIMARY KEY,
      password_hash VARCHAR(255),
      contact_id INT,
      resource_id INT,
      signup_id INT UNIQUE
    )
  `)

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS resource(
      resource_id SERIAL PRIMARY KEY,
      title VARCHAR(200),
      category VARCHAR(100),
      description VARCHAR(500),
      resource_content TEXT,
      file_link VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      student_id INT,
      CONSTRAINT fk_resource_student
      FOREIGN KEY (student_id) REFERENCES student(student_id)
    )
  `)

  await dbPool.query('ALTER TABLE resource ADD COLUMN IF NOT EXISTS title VARCHAR(200)')
  await dbPool.query('ALTER TABLE resource ADD COLUMN IF NOT EXISTS category VARCHAR(100)')
  await dbPool.query('ALTER TABLE resource ADD COLUMN IF NOT EXISTS description VARCHAR(500)')
  await dbPool.query('ALTER TABLE resource ADD COLUMN IF NOT EXISTS resource_content TEXT')
  await dbPool.query('ALTER TABLE resource ADD COLUMN IF NOT EXISTS file_link VARCHAR(500)')
  await dbPool.query('ALTER TABLE resource ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
  await dbPool.query('ALTER TABLE resource ADD COLUMN IF NOT EXISTS student_id INT')

  await dbPool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'resource'
          AND constraint_name = 'fk_resource_student'
      ) THEN
        ALTER TABLE resource
          ADD CONSTRAINT fk_resource_student
          FOREIGN KEY (student_id) REFERENCES student(student_id);
      END IF;
    END $$;
  `)

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS emergency_contact(
      contact_id SERIAL PRIMARY KEY,
      conatct_name VARCHAR(100),
      phone_no BIGINT,
      student_id INT,
      CONSTRAINT fk_contact_student
      FOREIGN KEY (student_id) REFERENCES student(student_id)
    )
  `)

  await dbPool.query('ALTER TABLE emergency_contact ADD COLUMN IF NOT EXISTS conatct_name VARCHAR(100)')
  await dbPool.query('ALTER TABLE emergency_contact ADD COLUMN IF NOT EXISTS contact_name VARCHAR(100)')
  await dbPool.query('ALTER TABLE emergency_contact ADD COLUMN IF NOT EXISTS phone_no BIGINT')
  await dbPool.query('ALTER TABLE emergency_contact ALTER COLUMN phone_no TYPE BIGINT USING phone_no::BIGINT')
  await dbPool.query('ALTER TABLE emergency_contact ADD COLUMN IF NOT EXISTS student_id INT')

  await dbPool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'emergency_contact'
          AND constraint_name = 'fk_contact_student'
      ) THEN
        ALTER TABLE emergency_contact
          ADD CONSTRAINT fk_contact_student
          FOREIGN KEY (student_id) REFERENCES student(student_id);
      END IF;
    END $$;
  `)

  await dbPool.query(`
    UPDATE emergency_contact
    SET contact_name = COALESCE(contact_name, conatct_name),
        conatct_name = COALESCE(conatct_name, contact_name)
    WHERE contact_name IS NULL OR conatct_name IS NULL
  `)

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS admin_kpi_overrides(
      override_id INT PRIMARY KEY DEFAULT 1,
      total_students INT,
      mentors_active INT,
      psychiatrists_active INT,
      assignments_active INT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (override_id = 1)
    )
  `)

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS complaints(
      complaint_id SERIAL PRIMARY KEY,
      student_id INT NOT NULL REFERENCES student(student_id) ON DELETE CASCADE,
      issue_type VARCHAR(50) NOT NULL DEFAULT 'assignment',
      details TEXT NOT NULL,
      preferred_role VARCHAR(30),
      against_role VARCHAR(30),
      against_id INT,
      current_assigned_role VARCHAR(30),
      current_assigned_id INT,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      resolution_note TEXT,
      reassigned_role VARCHAR(30),
      reassigned_id INT,
      admin_signup_id INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `)

  await dbPool.query('CREATE INDEX IF NOT EXISTS idx_complaints_student_created ON complaints(student_id, created_at DESC)')
  await dbPool.query('CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status)')
}

// Create mentor notes and checklist tables used by mentor workspace.
async function ensureMentorWorkspaceSchema(dbPool) {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS mentor_notes (
      note_id SERIAL PRIMARY KEY,
      mentor_id INT NOT NULL REFERENCES mentor(mentor_id) ON DELETE CASCADE,
      note_text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS mentor_checklist (
      item_id SERIAL PRIMARY KEY,
      mentor_id INT NOT NULL REFERENCES mentor(mentor_id) ON DELETE CASCADE,
      item_text VARCHAR(500) NOT NULL,
      is_done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await dbPool.query('CREATE INDEX IF NOT EXISTS idx_mentor_notes_lookup ON mentor_notes(mentor_id, created_at DESC)')
  await dbPool.query('CREATE INDEX IF NOT EXISTS idx_mentor_checklist_lookup ON mentor_checklist(mentor_id, created_at DESC)')
}

// Create psychiatrist workspace tables while handling legacy schema variants.
async function ensurePsychiatristWorkspaceSchema(dbPool) {
  const psychiatristMeta = await resolvePsychiatristTableMeta(dbPool)

  if (psychiatristMeta) {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS psychiatrist_notes (
        note_id SERIAL PRIMARY KEY,
        psychiatrist_id INT NOT NULL REFERENCES ${psychiatristMeta.table}(${psychiatristMeta.idColumn}) ON DELETE CASCADE,
        note_text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS psychiatrist_risk_overview (
        risk_id SERIAL PRIMARY KEY,
        psychiatrist_id INT NOT NULL REFERENCES ${psychiatristMeta.table}(${psychiatristMeta.idColumn}) ON DELETE CASCADE,
        item_text VARCHAR(500) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  } else {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS psychiatrist_notes (
        note_id SERIAL PRIMARY KEY,
        psychiatrist_id INT NOT NULL,
        note_text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS psychiatrist_risk_overview (
        risk_id SERIAL PRIMARY KEY,
        psychiatrist_id INT NOT NULL,
        item_text VARCHAR(500) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  }

  await dbPool.query(
    'CREATE INDEX IF NOT EXISTS idx_psychiatrist_notes_lookup ON psychiatrist_notes(psychiatrist_id, created_at DESC)'
  )
  await dbPool.query(
    'CREATE INDEX IF NOT EXISTS idx_psychiatrist_risk_lookup ON psychiatrist_risk_overview(psychiatrist_id, created_at DESC)'
  )
}

// Resolve mentor workspace ID from mentor_id or signup_id.
async function resolveMentorWorkspaceId(dbPool, rawId) {
  const numericId = parsePositiveInt(rawId)
  if (!numericId) return null

  const byMentorId = await dbPool.query('SELECT mentor_id FROM mentor WHERE mentor_id = $1 LIMIT 1', [numericId])
  if (byMentorId.rows[0]) return Number(byMentorId.rows[0].mentor_id)

  const bySignupId = await dbPool.query('SELECT mentor_id FROM mentor WHERE signup_id = $1 LIMIT 1', [numericId])
  if (bySignupId.rows[0]) return Number(bySignupId.rows[0].mentor_id)

  return null
}

// Resolve psychiatrist workspace ID from psychiatrist_id or signup_id.
async function resolvePsychiatristWorkspaceId(dbPool, rawId) {
  const numericId = parsePositiveInt(rawId)
  if (!numericId) return null

  const psychiatristMeta = await resolvePsychiatristTableMeta(dbPool)
  if (!psychiatristMeta) return null

  const byPsychiatristId = await dbPool.query(
    `SELECT ${psychiatristMeta.idColumn} AS resolved_id FROM ${psychiatristMeta.table} WHERE ${psychiatristMeta.idColumn} = $1 LIMIT 1`,
    [numericId]
  )
  if (byPsychiatristId.rows[0]) return Number(byPsychiatristId.rows[0].resolved_id)

  if (psychiatristMeta.hasSignupColumn) {
    const bySignupId = await dbPool.query(
      `SELECT ${psychiatristMeta.idColumn} AS resolved_id FROM ${psychiatristMeta.table} WHERE signup_id = $1 LIMIT 1`,
      [numericId]
    )
    if (bySignupId.rows[0]) return Number(bySignupId.rows[0].resolved_id)
  }

  return null
}

// Normalize a single questionnaire answer token.
function normalizeAnswer(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
}

// Normalize a comma-separated answer into a searchable set.
function normalizeAnswerSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
  )
}

// Compute assignment target role from questionnaire scoring rules.
function computeAssignmentDecision(answers) {
  const periodAffected = normalizeAnswer(answers.period_affected)
  const supportType = normalizeAnswer(answers.support_type)
  const supportPreferenceSet = normalizeAnswerSet(answers.support_preferences)
  const sessionStructure = normalizeAnswerSet(answers.session_structure)
  const communication = normalizeAnswerSet(answers.communication)

  const mentorDurations = new Set(['less than 2 weeks', '2-4 weeks'])
  const psychiatristDurations = new Set(['1-3 months', 'more than 3 months'])

  const mentorPreferenceOptions = new Set(['someone to listen', 'academic guidance', 'emotional support'])
  const psychiatristPreferenceOptions = new Set(['stress management', 'professional support'])

  const isMentorDuration = mentorDurations.has(periodAffected)
  const isPsychiatristDuration = psychiatristDurations.has(periodAffected)

  const supportTypeIsEither = supportType === 'either'
  const eitherSupportsMentor = supportTypeIsEither && isMentorDuration
  const eitherSupportsPsychiatrist = supportTypeIsEither && !isMentorDuration

  let mentorScore = 0
  let psychiatristScore = 0

  if (isMentorDuration) mentorScore += 1
  if (isPsychiatristDuration) psychiatristScore += 1

  if (supportType === 'peer mentor' || supportType === 'not sure' || eitherSupportsMentor) mentorScore += 1
  if (supportType === 'professional support from a psychiatrist' || eitherSupportsPsychiatrist) psychiatristScore += 1

  if (Array.from(mentorPreferenceOptions).some((option) => supportPreferenceSet.has(option))) mentorScore += 1
  if (Array.from(psychiatristPreferenceOptions).some((option) => supportPreferenceSet.has(option))) psychiatristScore += 1

  if (sessionStructure.has('flexible') || (sessionStructure.has('balanced') && eitherSupportsMentor)) mentorScore += 1
  if (sessionStructure.has('structured') || (sessionStructure.has('balanced') && eitherSupportsPsychiatrist)) psychiatristScore += 1

  if (communication.has('casual') || (communication.has('balanced') && eitherSupportsMentor)) mentorScore += 1
  if (communication.has('formal') || (communication.has('balanced') && eitherSupportsPsychiatrist)) psychiatristScore += 1

  let assignedRole = null
  if (mentorScore > psychiatristScore) {
    assignedRole = 'mentor'
  } else if (psychiatristScore > mentorScore) {
    assignedRole = 'psychiatrist'
  } else if (supportType === 'peer mentor' || supportType === 'not sure') {
    assignedRole = 'mentor'
  } else if (supportType === 'professional support from a psychiatrist') {
    assignedRole = 'psychiatrist'
  } else if (isMentorDuration) {
    assignedRole = 'mentor'
  } else if (isPsychiatristDuration) {
    assignedRole = 'psychiatrist'
  }

  return {
    mentorScore,
    psychiatristScore,
    assignedRole,
  }
}

// Find the least-loaded available staff member for assignment.
async function findLeastLoadedAssignee(dbPool, role) {
  if (role === 'mentor') {
    const result = await dbPool.query(
      `
      SELECT m.mentor_id AS assignee_id, COUNT(a.assignment_id)::int AS assigned_count
      FROM mentor m
      LEFT JOIN assignments a ON a.mentor_id = m.mentor_id
      GROUP BY m.mentor_id
      HAVING COUNT(a.assignment_id) < 5
      ORDER BY assigned_count ASC, m.mentor_id ASC
      LIMIT 1
      `
    )
    return result.rows[0] ? Number(result.rows[0].assignee_id) : null
  }

  if (role === 'psychiatrist') {
    const result = await dbPool.query(
      `
      SELECT p.psychiatrist_id AS assignee_id, COUNT(a.assignment_id)::int AS assigned_count
      FROM psychiatrist p
      LEFT JOIN assignments a ON a.psychiatrist_id = p.psychiatrist_id
      GROUP BY p.psychiatrist_id
      HAVING COUNT(a.assignment_id) < 5
      ORDER BY assigned_count ASC, p.psychiatrist_id ASC
      LIMIT 1
      `
    )
    return result.rows[0] ? Number(result.rows[0].assignee_id) : null
  }

  return null
}

// Find the referenced target table behind a questionnaire FK constraint.
async function getQuestionnaireForeignKeyTarget(dbPool, constraintName) {
  const target = await dbPool.query(
    `
    SELECT ccu.table_name AS referenced_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'questionnaire'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND tc.constraint_name = $1
    LIMIT 1
    `,
    [constraintName]
  )

  return target.rows[0] ? String(target.rows[0].referenced_table) : null
}

// Validate assignee IDs against current questionnaire foreign-key targets.
async function resolveQuestionnaireAssigneeId(dbPool, role, proposedId) {
  const numericId = Number(proposedId)
  if (!Number.isInteger(numericId) || numericId <= 0) return null

  if (role === 'mentor') {
    const fkTarget = await getQuestionnaireForeignKeyTarget(dbPool, 'fk_qst_mentor')
    if (!fkTarget || fkTarget === 'mentor') {
      const exists = await dbPool.query('SELECT mentor_id FROM mentor WHERE mentor_id = $1 LIMIT 1', [numericId])
      return exists.rows[0] ? numericId : null
    }

    return null
  }

  if (role === 'psychiatrist') {
    const fkTarget = await getQuestionnaireForeignKeyTarget(dbPool, 'fk_qst_psychiatrist')
    if (!fkTarget || fkTarget === 'psychiatrist') {
      const exists = await dbPool.query('SELECT psychiatrist_id FROM psychiatrist WHERE psychiatrist_id = $1 LIMIT 1', [
        numericId,
      ])
      return exists.rows[0] ? numericId : null
    }

    return null
  }

  return null
}

// Ensure questionnaire and assignments write schema stays compatible.
async function ensureQuestionnaireWriteSchema(dbPool) {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS assignments (
      assignment_id SERIAL PRIMARY KEY,
      username VARCHAR(100),
      student_id INT UNIQUE REFERENCES student(student_id),
      mentor_id INT REFERENCES mentor(mentor_id),
      psychiatrist_id INT REFERENCES psychiatrist(psychiatrist_id)
    )
  `)
  await dbPool.query('DROP INDEX IF EXISTS idx_assignments_username_unique')
  await dbPool.query('ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_username_key')
  await dbPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_student_unique ON assignments(student_id)')

  // Compatibility guard for older questionnaire schema variants.
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS mentalhealthsupport VARCHAR(10)')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS concerns VARCHAR(200)')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS period_affected VARCHAR(50)')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS support_type VARCHAR(50)')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS support_preferences VARCHAR(50)')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS support_preference VARCHAR(50)')
  await dbPool.query('ALTER TABLE questionnaire ALTER COLUMN support_preferences TYPE TEXT')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS religion TEXT')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS religion_type VARCHAR(50)')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS spiritual_status VARCHAR(50)')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS therapy_status VARCHAR(10)')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS seek_support TEXT')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS expectations TEXT')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS session_structure VARCHAR(50)')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS communication VARCHAR(50)')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS mentor_id INT')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS psychiatrist_id INT')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()')

  await dbPool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'questionnaire'
          AND column_name = 'support_preference'
      ) THEN
        ALTER TABLE questionnaire ALTER COLUMN support_preference SET DEFAULT '';
      END IF;
    END $$;
  `)

  await dbPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_questionnaire_student_unique ON questionnaire(student_id)')

  const fkTarget = await dbPool.query(
    `
    SELECT ccu.table_name AS referenced_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'questionnaire'
      AND tc.constraint_name = 'fk_qst_student'
      AND tc.constraint_type = 'FOREIGN KEY'
    LIMIT 1
    `
  )

  if (fkTarget.rows[0] && String(fkTarget.rows[0].referenced_table) !== 'student') {
    await dbPool.query('ALTER TABLE questionnaire DROP CONSTRAINT IF EXISTS fk_qst_student')
    await dbPool.query(
      'ALTER TABLE questionnaire ADD CONSTRAINT fk_qst_student FOREIGN KEY (student_id) REFERENCES student(student_id) ON DELETE CASCADE'
    )
  } else if (!fkTarget.rows[0]) {
    await dbPool.query(
      'ALTER TABLE questionnaire ADD CONSTRAINT fk_qst_student FOREIGN KEY (student_id) REFERENCES student(student_id) ON DELETE CASCADE'
    )
  }
}

// Resolve student identity for questionnaire flows, creating row if needed.
async function resolveStudentIdForQuestionnaire(dbPool, rawStudentId) {
  const numericId = Number(rawStudentId)
  if (!Number.isInteger(numericId) || numericId <= 0) return null

  const byStudentId = await dbPool.query('SELECT student_id FROM student WHERE student_id = $1 LIMIT 1', [numericId])
  if (byStudentId.rows[0]) return Number(byStudentId.rows[0].student_id)

  const bySignupId = await dbPool.query('SELECT student_id FROM student WHERE signup_id = $1 LIMIT 1', [numericId])
  if (bySignupId.rows[0]) return Number(bySignupId.rows[0].student_id)

  const signupRow = await dbPool.query(
    `
    SELECT s.signup_id, s.email
    FROM signup s
    WHERE s.signup_id = $1
      AND LOWER(COALESCE(s.role, s.role_name, '')) = 'student'
    LIMIT 1
    `,
    [numericId]
  )

  if (!signupRow.rows[0]) return null

  const signup = signupRow.rows[0]
  const username = buildStudentUsername(signup.email)
  await ensureStudentIdAutoIncrement(dbPool)
  const inserted = await dbPool.query(
    `
    INSERT INTO student (signup_id, email, username)
    VALUES ($1, $2, $3)
    ON CONFLICT (signup_id)
    DO UPDATE SET email = EXCLUDED.email
    RETURNING student_id
    `,
    [Number(signup.signup_id), String(signup.email), username]
  )

  return inserted.rows[0] ? Number(inserted.rows[0].student_id) : null
}

// Add auto-increment default for student primary key on legacy schemas.
async function ensureStudentIdAutoIncrement(dbPool) {
  await dbPool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'student'
          AND column_name = 'student_id'
      ) THEN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'student'
            AND column_name = 'student_id'
            AND column_default IS NOT NULL
        ) THEN
          IF to_regclass('public.student_student_id_seq') IS NULL THEN
            CREATE SEQUENCE public.student_student_id_seq;
          END IF;

          PERFORM setval(
            'public.student_student_id_seq',
            COALESCE((SELECT MAX(student_id) FROM student), 0) + 1,
            false
          );

          ALTER TABLE student
            ALTER COLUMN student_id SET DEFAULT nextval('public.student_student_id_seq');
        END IF;
      END IF;
    END $$;
  `)
}

// Add auto-increment default for mentor primary key on legacy schemas.
async function ensureMentorIdAutoIncrement(dbPool) {
  await dbPool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'mentor'
          AND column_name = 'mentor_id'
      ) THEN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'mentor'
            AND column_name = 'mentor_id'
            AND column_default IS NOT NULL
        ) THEN
          IF to_regclass('public.mentor_mentor_id_seq') IS NULL THEN
            CREATE SEQUENCE public.mentor_mentor_id_seq;
          END IF;

          PERFORM setval(
            'public.mentor_mentor_id_seq',
            COALESCE((SELECT MAX(mentor_id) FROM mentor), 0) + 1,
            false
          );

          ALTER TABLE mentor
            ALTER COLUMN mentor_id SET DEFAULT nextval('public.mentor_mentor_id_seq');
        END IF;
      END IF;
    END $$;
  `)
}

// Add auto-increment default for psychiatrist primary key on legacy schemas.
async function ensurePsychiatristIdAutoIncrement(dbPool) {
  await dbPool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'psychiatrist'
          AND column_name = 'psychiatrist_id'
      ) THEN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'psychiatrist'
            AND column_name = 'psychiatrist_id'
            AND column_default IS NOT NULL
        ) THEN
          IF to_regclass('public.psychiatrist_psychiatrist_id_seq') IS NULL THEN
            CREATE SEQUENCE public.psychiatrist_psychiatrist_id_seq;
          END IF;

          PERFORM setval(
            'public.psychiatrist_psychiatrist_id_seq',
            COALESCE((SELECT MAX(psychiatrist_id) FROM psychiatrist), 0) + 1,
            false
          );

          ALTER TABLE psychiatrist
            ALTER COLUMN psychiatrist_id SET DEFAULT nextval('public.psychiatrist_psychiatrist_id_seq');
        END IF;
      END IF;
    END $$;
  `)
}

// Reserved legacy sync hook; intentionally no-op.
async function syncLegacyStudentTableIfPresent(dbPool, studentId) {
  return
}

// Resolve a role record from roles table with psychiatrist/psychologist fallback.
async function resolveRoleRow(dbPool, normalizedRole) {
  const candidates = [normalizedRole]
  if (normalizedRole === 'psychiatrist') candidates.push('psychologist')

  const result = await dbPool.query(
    `
    SELECT role_id, role_name
    FROM roles
    WHERE LOWER(role_name) = ANY($1)
    ORDER BY CASE WHEN LOWER(role_name) = $2 THEN 0 ELSE 1 END
    LIMIT 1
    `,
    [candidates.map((v) => String(v || '').toLowerCase()), String(normalizedRole || '').toLowerCase()]
  )

  return result.rows[0] || null
}

// Ensure password_hash column exists on role profile tables.
async function ensurePasswordHashColumn(dbPool, table) {
  if (table === 'admins') return
  const sql = `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = 'password_hash'
    ) AS exists
  `
  const check = await dbPool.query(sql, [table])
  if (check.rows[0] && check.rows[0].exists) return
  await dbPool.query(`ALTER TABLE ${table} ADD COLUMN password_hash VARCHAR(255)`)
}

// Create role-specific profile rows during staff account creation.
async function ensureRoleProfileRow(dbPool, { role, table, userIdCol, signupId, email, fullName = '', passwordHash = null }) {
  if (role === 'student') {
    const username = buildStudentUsername(email)
    const sql = `
      INSERT INTO ${table} (signup_id, email, username)
      VALUES ($1, $2, $3)
      RETURNING ${userIdCol}
    `
    const row = await dbPool.query(sql, [signupId, email, username])
    return String(row.rows[0][userIdCol])
  }

  if (role === 'mentor' || role === 'psychiatrist') {
    if (role === 'mentor') await ensureMentorIdAutoIncrement(dbPool)
    if (role === 'psychiatrist') await ensurePsychiatristIdAutoIncrement(dbPool)

    const safeFullName = String(fullName || '').trim()
    if (!safeFullName) return null
    const shouldSetPasswordHash = typeof passwordHash === 'string' && Boolean(passwordHash)

    const sql = shouldSetPasswordHash
      ? `
      INSERT INTO ${table} (signup_id, email, full_name, password_hash)
      VALUES ($1, $2, $3, $4)
      RETURNING ${userIdCol}
    `
      : `
      INSERT INTO ${table} (signup_id, email, full_name)
      VALUES ($1, $2, $3)
      RETURNING ${userIdCol}
    `

    const row = shouldSetPasswordHash
      ? await dbPool.query(sql, [signupId, email, safeFullName, passwordHash])
      : await dbPool.query(sql, [signupId, email, safeFullName])
    return String(row.rows[0][userIdCol])
  }

  return null
}

// Recover or repair linkage between signup records and role profile rows.
async function resolveOrRepairRoleProfileRow(dbPool, { role, table, userIdCol, signupId, email }) {
  if (role === 'admin') {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        admin_id SERIAL PRIMARY KEY,
        password_hash VARCHAR(255),
        contact_id INT,
        resource_id INT,
        signup_id INT UNIQUE
      )
    `)
    await dbPool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS signup_id INT UNIQUE')
    const adminBySignup = await dbPool.query('SELECT admin_id AS user_id FROM admins WHERE signup_id = $1 LIMIT 1', [
      Number(signupId),
    ])
    return adminBySignup.rows[0] ? String(adminBySignup.rows[0].user_id) : null
  }

  const bySignup = await dbPool.query(`SELECT ${userIdCol} AS user_id FROM ${table} WHERE signup_id = $1 LIMIT 1`, [signupId])
  if (bySignup.rows[0]) return String(bySignup.rows[0].user_id)

  const byEmail = await dbPool.query(
    `SELECT ${userIdCol} AS user_id, signup_id FROM ${table} WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  )

  if (byEmail.rows[0]) {
    const existing = byEmail.rows[0]
    const existingSignupId = existing.signup_id != null ? Number(existing.signup_id) : null
    const currentSignupId = Number(signupId)

    if (existingSignupId == null || existingSignupId === currentSignupId) {
      await dbPool.query(`UPDATE ${table} SET signup_id = $1 WHERE ${userIdCol} = $2`, [
        currentSignupId,
        Number(existing.user_id),
      ])
      return String(existing.user_id)
    }

    // A different signup_id already owns this profile row; do not auto-relink.
    return null
  }

  return null
}

// Register remaining legacy endpoints until full extraction is complete.
function setupLegacyAuthRoutes(app, dbPool) {
  setupQuestionnaireRoutes({
    app,
    dbPool,
    sanitizeRole,
    ensureQuestionnaireWriteSchema,
    resolveStudentIdForQuestionnaire,
    syncLegacyStudentTableIfPresent,
    computeAssignmentDecision,
    findLeastLoadedAssignee,
    resolveQuestionnaireAssigneeId,
  })

  setupProfileRoutes({
    app,
    dbPool,
    sanitizeRole,
    buildStudentUsername,
    parseNullablePhone,
    ensureStudentIdAutoIncrement,
    ensureMentorIdAutoIncrement,
    ensurePsychiatristIdAutoIncrement,
    syncLegacyStudentTableIfPresent,
    dashboardPath,
    createSessionToken,
    tableExists,
  })

  // Resolve internal user IDs by role and identifier for frontend integrations.
  app.get('/api/users/resolve-id', async (req, res) => {
    try {
      const role = sanitizeRole(req.query.role)
      const identifier = String(req.query.identifier || '').trim()
      if (!role || !identifier) {
        return res.status(400).json({ error: 'role and identifier are required.' })
      }

      if (role === 'student') {
        const student = await dbPool.query(
          `
          SELECT student_id
          FROM student
          WHERE username = $1
             OR LOWER(email) = LOWER($1)
             OR student_id::text = $1
             OR signup_id::text = $1
          ORDER BY student_id ASC
          LIMIT 1
          `,
          [identifier]
        )

        return res.json({ userId: student.rows[0] ? Number(student.rows[0].student_id) : null })
      }

      if (role === 'mentor') {
        const mentor = await dbPool.query(
          `
          SELECT mentor_id
          FROM mentor
          WHERE LOWER(full_name) = LOWER($1)
             OR LOWER(email) = LOWER($1)
             OR mentor_id::text = $1
             OR signup_id::text = $1
          ORDER BY mentor_id ASC
          LIMIT 1
          `,
          [identifier]
        )

        return res.json({ userId: mentor.rows[0] ? Number(mentor.rows[0].mentor_id) : null })
      }

      if (role === 'psychiatrist') {
        const psychiatristMeta = await resolvePsychiatristTableMeta(dbPool)
        if (!psychiatristMeta) {
          return res.json({ userId: null })
        }

        const signupFilter = psychiatristMeta.hasSignupColumn ? ' OR signup_id::text = $1' : ''

        const psychiatrist = await dbPool.query(
          `
          SELECT ${psychiatristMeta.idColumn} AS resolved_id
          FROM ${psychiatristMeta.table}
          WHERE LOWER(full_name) = LOWER($1)
             OR LOWER(email) = LOWER($1)
             OR ${psychiatristMeta.idColumn}::text = $1
             ${signupFilter}
          ORDER BY ${psychiatristMeta.idColumn} ASC
          LIMIT 1
          `,
          [identifier]
        )

        return res.json({ userId: psychiatrist.rows[0] ? Number(psychiatrist.rows[0].resolved_id) : null })
      }

      return res.status(400).json({ error: 'Unsupported role for ID lookup.' })
    } catch (err) {
      console.error('Failed to resolve user ID:', err.message)
      return res.status(500).json({ error: 'Could not resolve user ID.' })
    }
  })

  // Return therapist list for booking flows by selected therapist type.
  app.get('/api/therapists', async (req, res) => {
    try {
      const therapistType = normalizeTherapistType(req.query.type)
      if (!therapistType) {
        return res.status(400).json({ error: 'Valid therapist type is required.' })
      }

      if (therapistType === 'mentor') {
        const result = await dbPool.query(
          `
          SELECT mentor_id AS therapist_id,
                 COALESCE(NULLIF(full_name, ''), email, 'Mentor') AS display_name
          FROM mentor
          ORDER BY mentor_id ASC
          `
        )

        return res.json({
          therapists: result.rows.map((row) => ({
            therapistId: Number(row.therapist_id),
            displayName: String(row.display_name || 'Mentor'),
          })),
        })
      }

      const psychiatristMeta = await resolvePsychiatristTableMeta(dbPool)
      if (!psychiatristMeta) {
        return res.json({ therapists: [] })
      }

      const result = await dbPool.query(
        `
        SELECT ${psychiatristMeta.idColumn} AS therapist_id,
               COALESCE(NULLIF(full_name, ''), email, 'Psychologist') AS display_name
        FROM ${psychiatristMeta.table}
        ORDER BY ${psychiatristMeta.idColumn} ASC
        `
      )

      return res.json({
        therapists: result.rows.map((row) => ({
          therapistId: Number(row.therapist_id),
          displayName: String(row.display_name || 'Psychologist'),
        })),
      })
    } catch (err) {
      console.error('Failed to load therapists:', err.message)
      return res.status(500).json({ error: 'Could not load therapists.' })
    }
  })

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

    await ensureAppointmentSchema(dbPool)

    const client = await dbPool.connect()
    try {
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
      await client.query('ROLLBACK')
      console.error('Failed to book appointment:', err.message)
      res.status(500).json({ error: 'Failed to book appointment.' })
    } finally {
      client.release()
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

  // Student-only signup endpoint using credentials in signup table.
  app.post('/api/signup', async (req, res) => {
    try {
      const { email, password } = req.body || {}
      const normalizedRole = 'student'

      if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email is required' })
      if (!password || typeof password !== 'string') return res.status(400).json({ error: 'Password is required' })
      if (!isStrongPassword(password)) {
        return res.status(400).json({
          error:
            'Password must be more than 6 characters and include uppercase, lowercase, and a special character.',
        })
      }
      const table = roleToTable(normalizedRole)
      if (!table) return res.status(400).json({ error: 'Invalid role' })

      const roleRow = await resolveRoleRow(dbPool, normalizedRole)
      if (!roleRow) return res.status(400).json({ error: 'Role mapping missing in roles table.' })

      await ensurePasswordHashColumn(dbPool, table)

      const existingSignup = await dbPool.query('SELECT signup_id FROM signup WHERE LOWER(email) = LOWER($1) LIMIT 1', [email])
      if (existingSignup.rows[0]) return res.status(409).json({ error: 'Email already exists. Please log in.' })

      const passwordHash = await bcrypt.hash(password, 10)
      const signupInsert = await dbPool.query(
        'INSERT INTO signup (email, role_id, role_name, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING signup_id',
        [email, Number(roleRow.role_id), String(roleRow.role_name), normalizedRole, passwordHash]
      )

      const signupId = Number(signupInsert.rows[0].signup_id)

      return res.json({
        ok: true,
        role: normalizedRole,
        signupId: String(signupId),
        userId: null,
        profileComplete: false,
        redirectTo: profilePath(normalizedRole),
        message: 'Signup successful.',
      })
    } catch (err) {
      if (err && err.code === '23505') {
        return res.status(409).json({ error: 'Email already exists. Please log in.' })
      }
      console.error('Signup failed:', err.message)
      return res.status(500).json({ error: 'Signup failed' })
    }
  })

  // Role-resolving login endpoint with session token issuance.
  app.post('/api/login', async (req, res) => {
    try {
      const { email, password } = req.body || {}

      if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email is required' })
      if (!password || typeof password !== 'string') return res.status(400).json({ error: 'Password is required' })

      const signupResult = await dbPool.query(
        'SELECT signup_id, role, role_name, password_hash FROM signup WHERE LOWER(email) = LOWER($1)',
        [email]
      )
      if (!signupResult.rows[0]) return res.status(401).json({ error: 'Invalid email or password' })

      let matchedSignup = null
      for (const row of signupResult.rows) {
        const storedPasswordHash = String(row.password_hash || '')
        if (!storedPasswordHash) continue
        const ok = await bcrypt.compare(password, storedPasswordHash)
        if (ok) {
          matchedSignup = row
          break
        }
      }

      if (!matchedSignup) return res.status(401).json({ error: 'Invalid email or password' })

      const normalizedRole = sanitizeRole(matchedSignup.role || matchedSignup.role_name)
      if (!normalizedRole) return res.status(401).json({ error: 'Invalid email or password' })

      const table = roleToTable(normalizedRole)
      const userIdCol = roleIdColumn(normalizedRole)
      if (!table || !userIdCol) return res.status(400).json({ error: 'Invalid role' })
      const signupId = Number(matchedSignup.signup_id)

      const userId = await resolveOrRepairRoleProfileRow(dbPool, {
        role: normalizedRole,
        table,
        userIdCol,
        signupId: Number(signupId),
        email,
      })

      if (!userId) {
        const sessionToken = createSessionToken({ userId: String(signupId), role: normalizedRole })
        return res.json({
          ok: true,
          role: normalizedRole,
          userId: null,
          signupId: String(signupId),
          profileComplete: false,
          needsQuestionnaire: normalizedRole === 'student',
          redirectTo: profilePath(normalizedRole),
          sessionToken,
        })
      }

      let needsQuestionnaire = false
      if (normalizedRole === 'student') {
        const q = await dbPool.query('SELECT questionnaire_id FROM questionnaire WHERE student_id = $1 LIMIT 1', [Number(userId)])
        needsQuestionnaire = !q.rows[0]
      }

      const redirectTo = normalizedRole === 'student' && needsQuestionnaire ? 'questionnaire.html' : dashboardPath(normalizedRole)

      const sessionToken = createSessionToken({ userId, role: normalizedRole })
      return res.json({
        ok: true,
        role: normalizedRole,
        userId,
        signupId: String(signupId),
        profileComplete: true,
        needsQuestionnaire,
        redirectTo,
        sessionToken,
      })
    } catch (err) {
      console.error('Login failed:', err.message)
      return res.status(500).json({ error: 'Login failed' })
    }
  })

  // List student journal entries.
  app.get('/api/journal', async (req, res) => {
    try {
      const providedStudentId = parsePositiveInt(req.query.studentId)
      if (!providedStudentId) {
        return res.status(400).json({ error: 'Valid studentId is required.' })
      }

      await ensureJournalSchema(dbPool)

      const resolvedStudentId = await resolveStudentIdForQuestionnaire(dbPool, providedStudentId)
      if (!resolvedStudentId) {
        return res.status(404).json({ error: 'Student profile not found.' })
      }

      const result = await dbPool.query(
        `
        SELECT
          journal_id,
          student_id,
          title,
          journal_entry,
          mood,
          created_at,
          updated_at
        FROM journal
        WHERE student_id = $1
        ORDER BY created_at DESC
        `,
        [resolvedStudentId]
      )

      return res.json({
        entries: result.rows.map((row) => ({
          journalId: Number(row.journal_id),
          studentId: Number(row.student_id),
          title: row.title || 'Untitled entry',
          journalEntry: String(row.journal_entry || ''),
          mood: row.mood || null,
          createdAt: toIsoString(row.created_at),
          updatedAt: toIsoString(row.updated_at),
        })),
      })
    } catch (err) {
      console.error('Failed to load journal entries:', err.message)
      return res.status(500).json({ error: 'Failed to load journal entries.' })
    }
  })

  // Create a student journal entry.
  app.post('/api/journal', async (req, res) => {
    try {
      const providedStudentId = parsePositiveInt(req.body?.studentId)
      const title = String(req.body?.title || '').trim().slice(0, 255)
      const journalEntry = String(req.body?.journalEntry || '').trim()
      const mood = String(req.body?.mood || '').trim().toLowerCase().slice(0, 50)

      if (!providedStudentId) {
        return res.status(400).json({ error: 'Valid studentId is required.' })
      }
      if (!journalEntry) {
        return res.status(400).json({ error: 'Journal entry cannot be empty.' })
      }

      await ensureJournalSchema(dbPool)

      const resolvedStudentId = await resolveStudentIdForQuestionnaire(dbPool, providedStudentId)
      if (!resolvedStudentId) {
        return res.status(404).json({ error: 'Student profile not found.' })
      }

      const insert = await dbPool.query(
        `
        INSERT INTO journal (student_id, title, journal_entry, mood, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        RETURNING journal_id, student_id, title, journal_entry, mood, created_at, updated_at
        `,
        [resolvedStudentId, title || null, journalEntry, mood || null]
      )

      const entry = insert.rows[0]
      return res.status(201).json({
        entry: {
          journalId: Number(entry.journal_id),
          studentId: Number(entry.student_id),
          title: entry.title || 'Untitled entry',
          journalEntry: String(entry.journal_entry || ''),
          mood: entry.mood || null,
          createdAt: toIsoString(entry.created_at),
          updatedAt: toIsoString(entry.updated_at),
        },
      })
    } catch (err) {
      console.error('Failed to save journal entry:', err.message)
      return res.status(500).json({ error: 'Failed to save journal entry.' })
    }
  })

  // Update an existing student journal entry.
  app.put('/api/journal/:journalId', async (req, res) => {
    try {
      const journalId = parsePositiveInt(req.params.journalId)
      const providedStudentId = parsePositiveInt(req.body?.studentId)
      const title = String(req.body?.title || '').trim().slice(0, 255)
      const journalEntry = String(req.body?.journalEntry || '').trim()
      const mood = String(req.body?.mood || '').trim().toLowerCase().slice(0, 50)

      if (!journalId) return res.status(400).json({ error: 'Valid journalId is required.' })
      if (!providedStudentId) return res.status(400).json({ error: 'Valid studentId is required.' })
      if (!journalEntry) return res.status(400).json({ error: 'Journal entry cannot be empty.' })

      await ensureJournalSchema(dbPool)

      const resolvedStudentId = await resolveStudentIdForQuestionnaire(dbPool, providedStudentId)
      if (!resolvedStudentId) {
        return res.status(404).json({ error: 'Student profile not found.' })
      }

      const updated = await dbPool.query(
        `
        UPDATE journal
        SET title = $1,
            journal_entry = $2,
            mood = $3,
            updated_at = NOW()
        WHERE journal_id = $4
          AND student_id = $5
        RETURNING journal_id, student_id, title, journal_entry, mood, created_at, updated_at
        `,
        [title || null, journalEntry, mood || null, journalId, resolvedStudentId]
      )

      if (!updated.rows[0]) {
        return res.status(404).json({ error: 'Journal entry not found.' })
      }

      const entry = updated.rows[0]
      return res.json({
        entry: {
          journalId: Number(entry.journal_id),
          studentId: Number(entry.student_id),
          title: entry.title || 'Untitled entry',
          journalEntry: String(entry.journal_entry || ''),
          mood: entry.mood || null,
          createdAt: toIsoString(entry.created_at),
          updatedAt: toIsoString(entry.updated_at),
        },
      })
    } catch (err) {
      console.error('Failed to update journal entry:', err.message)
      return res.status(500).json({ error: 'Failed to update journal entry.' })
    }
  })

  // Delete a student journal entry.
  app.delete('/api/journal/:journalId', async (req, res) => {
    try {
      const journalId = parsePositiveInt(req.params.journalId)
      const providedStudentId = parsePositiveInt(req.query.studentId)

      if (!journalId) return res.status(400).json({ error: 'Valid journalId is required.' })
      if (!providedStudentId) return res.status(400).json({ error: 'Valid studentId is required.' })

      await ensureJournalSchema(dbPool)

      const resolvedStudentId = await resolveStudentIdForQuestionnaire(dbPool, providedStudentId)
      if (!resolvedStudentId) {
        return res.status(404).json({ error: 'Student profile not found.' })
      }

      const deleted = await dbPool.query(
        'DELETE FROM journal WHERE journal_id = $1 AND student_id = $2 RETURNING journal_id',
        [journalId, resolvedStudentId]
      )

      if (!deleted.rows[0]) {
        return res.status(404).json({ error: 'Journal entry not found.' })
      }

      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to delete journal entry:', err.message)
      return res.status(500).json({ error: 'Failed to delete journal entry.' })
    }
  })

  // Resolve chat peers for each role from assignment data.
  app.get('/api/chat/peers', async (req, res) => {
    try {
      const role = sanitizeRole(req.query.role)
      const userId = Number(req.query.userId)
      if (!role || !Number.isInteger(userId)) return res.status(400).json({ error: 'role and userId are required' })

      let resolvedUserId = userId

      if (role === 'student') {
        const resolved = await dbPool.query(
          `
          SELECT student_id
          FROM student
          WHERE student_id = $1 OR signup_id = $1
          ORDER BY CASE WHEN student_id = $1 THEN 0 ELSE 1 END
          LIMIT 1
          `,
          [userId]
        )
        if (resolved.rows[0]) {
          resolvedUserId = Number(resolved.rows[0].student_id)
        }
      }

      if (role === 'mentor') {
        const resolved = await dbPool.query(
          `
          SELECT mentor_id
          FROM mentor
          WHERE mentor_id = $1 OR signup_id = $1
          ORDER BY CASE WHEN mentor_id = $1 THEN 0 ELSE 1 END
          LIMIT 1
          `,
          [userId]
        )
        if (resolved.rows[0]) {
          resolvedUserId = Number(resolved.rows[0].mentor_id)
        }
      }

      if (role === 'psychiatrist') {
        const resolved = await dbPool.query(
          `
          SELECT psychiatrist_id
          FROM psychiatrist
          WHERE psychiatrist_id = $1 OR signup_id = $1
          ORDER BY CASE WHEN psychiatrist_id = $1 THEN 0 ELSE 1 END
          LIMIT 1
          `,
          [userId]
        )
        if (resolved.rows[0]) {
          resolvedUserId = Number(resolved.rows[0].psychiatrist_id)
        }
      }

      if (role === 'student') {
        const result = await dbPool.query(
          `
          SELECT DISTINCT
            peer_user_id,
            peer_role,
            display_name
          FROM (
            SELECT
              a.mentor_id::text AS peer_user_id,
              'mentor' AS peer_role,
              m.full_name AS display_name
            FROM assignments a
            INNER JOIN mentor m ON m.mentor_id = a.mentor_id
            WHERE a.student_id = $1
              AND a.mentor_id IS NOT NULL

            UNION ALL

            SELECT
              a.psychiatrist_id::text AS peer_user_id,
              'psychiatrist' AS peer_role,
              p.full_name AS display_name
            FROM assignments a
            INNER JOIN psychiatrist p ON p.psychiatrist_id = a.psychiatrist_id
            WHERE a.student_id = $1
              AND a.psychiatrist_id IS NOT NULL
          ) peer_rows
          ORDER BY peer_user_id
          `,
          [resolvedUserId]
        )
        return res.json({ ok: true, resolvedUserId: String(resolvedUserId), peers: result.rows })
      }

      if (role === 'mentor') {
        const result = await dbPool.query(
          `
          SELECT DISTINCT
            a.student_id::text AS peer_user_id,
            'student' AS peer_role,
            s.username AS display_name
          FROM assignments a
          INNER JOIN student s ON s.student_id = a.student_id
          WHERE a.mentor_id = $1 AND a.student_id IS NOT NULL
          ORDER BY peer_user_id
          `,
          [resolvedUserId]
        )
        return res.json({ ok: true, resolvedUserId: String(resolvedUserId), peers: result.rows })
      }

      if (role === 'psychiatrist') {
        const result = await dbPool.query(
          `
          SELECT DISTINCT
            a.student_id::text AS peer_user_id,
            'student' AS peer_role,
            s.username AS display_name
          FROM assignments a
          INNER JOIN student s ON s.student_id = a.student_id
          WHERE a.psychiatrist_id = $1 AND a.student_id IS NOT NULL
          ORDER BY peer_user_id
          `,
          [resolvedUserId]
        )
        return res.json({ ok: true, resolvedUserId: String(resolvedUserId), peers: result.rows })
      }

      return res.json({ ok: true, resolvedUserId: String(resolvedUserId), peers: [] })
    } catch (err) {
      console.error('Failed to load chat peers:', err.message)
      return res.status(500).json({ error: 'Failed to load peers' })
    }
  })

  // Aggregate admin dashboard users, assignments, and KPI stats.
  app.get('/api/admin/dashboard-data', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const usersResult = await dbPool.query(
        `
        SELECT
          s.signup_id,
          LOWER(COALESCE(s.role, s.role_name, '')) AS role,
          s.email,
          s.created_at,
          st.student_id,
          st.username AS student_username,
          st.full_name AS student_full_name,
          m.mentor_id,
          m.full_name AS mentor_full_name,
          p.psychiatrist_id,
          p.full_name AS psychiatrist_full_name,
          a.admin_id
        FROM signup s
        LEFT JOIN student st ON st.signup_id = s.signup_id
        LEFT JOIN mentor m ON m.signup_id = s.signup_id
        LEFT JOIN psychiatrist p ON p.signup_id = s.signup_id
        LEFT JOIN admins a ON a.signup_id = s.signup_id
        WHERE LOWER(COALESCE(s.role, s.role_name, '')) <> 'admin'
        ORDER BY s.created_at DESC
        `
      )

      const assignmentsResult = await dbPool.query(
        `
        SELECT
          a.assignment_id,
          a.student_id,
          s.username AS student_username,
          a.mentor_id,
          m.full_name AS mentor_name,
          a.psychiatrist_id,
          p.full_name AS psychiatrist_name
        FROM assignments a
        LEFT JOIN student s ON s.student_id = a.student_id
        LEFT JOIN mentor m ON m.mentor_id = a.mentor_id
        LEFT JOIN psychiatrist p ON p.psychiatrist_id = a.psychiatrist_id
        ORDER BY a.assignment_id DESC
        `
      )

      const users = usersResult.rows.map((row) => {
        const role = String(row.role || '')
        const userId =
          role === 'student'
            ? row.student_id
            : role === 'mentor'
              ? row.mentor_id
              : role === 'psychiatrist'
                ? row.psychiatrist_id
                : role === 'admin'
                  ? row.admin_id
                  : null

        const displayName =
          row.student_full_name ||
          row.student_username ||
          row.mentor_full_name ||
          row.psychiatrist_full_name ||
          row.email ||
          '-'

        return {
          signupId: Number(row.signup_id),
          userId: userId == null ? null : Number(userId),
          role,
          email: String(row.email || ''),
          displayName: String(displayName),
          createdAt: toIsoString(row.created_at),
        }
      })

      const assignments = assignmentsResult.rows.map((row) => ({
        assignmentId: Number(row.assignment_id),
        studentId: row.student_id == null ? null : Number(row.student_id),
        studentUsername: String(row.student_username || '-'),
        mentorId: row.mentor_id == null ? null : Number(row.mentor_id),
        mentorName: String(row.mentor_name || '-'),
        psychiatristId: row.psychiatrist_id == null ? null : Number(row.psychiatrist_id),
        psychiatristName: String(row.psychiatrist_name || '-'),
      }))

      const computed = {
        totalStudents: users.filter((u) => u.role === 'student').length,
        mentorsActive: users.filter((u) => u.role === 'mentor').length,
        psychiatristsActive: users.filter((u) => u.role === 'psychiatrist').length,
        assignmentsActive: assignments.length,
      }

      const overridesResult = await dbPool.query(
        `
        SELECT total_students, mentors_active, psychiatrists_active, assignments_active
        FROM admin_kpi_overrides
        WHERE override_id = 1
        LIMIT 1
        `
      )

      const overrideRow = overridesResult.rows[0] || {}
      const overrides = {
        totalStudents: overrideRow.total_students == null ? null : Number(overrideRow.total_students),
        mentorsActive: overrideRow.mentors_active == null ? null : Number(overrideRow.mentors_active),
        psychiatristsActive: overrideRow.psychiatrists_active == null ? null : Number(overrideRow.psychiatrists_active),
        assignmentsActive: overrideRow.assignments_active == null ? null : Number(overrideRow.assignments_active),
      }

      const effective = {
        totalStudents: overrides.totalStudents == null ? computed.totalStudents : overrides.totalStudents,
        mentorsActive: overrides.mentorsActive == null ? computed.mentorsActive : overrides.mentorsActive,
        psychiatristsActive: overrides.psychiatristsActive == null ? computed.psychiatristsActive : overrides.psychiatristsActive,
        assignmentsActive: overrides.assignmentsActive == null ? computed.assignmentsActive : overrides.assignmentsActive,
      }

      return res.json({ ok: true, users, assignments, stats: { computed, overrides, effective } })
    } catch (err) {
      console.error('Failed to load admin dashboard data:', err.message)
      return res.status(500).json({ error: 'Failed to load admin dashboard data.' })
    }
  })

  // Create mentor/psychiatrist staff login accounts.
  app.post('/api/admin/staff-accounts', async (req, res) => {
    try {
      const creation = await createStaffAccount({
        dbPool,
        bcrypt,
        sanitizeRole,
        isStrongPassword,
        resolveRoleRow,
        roleToTable,
        roleIdColumn,
        ensurePasswordHashColumn,
        ensureRoleProfileRow,
        body: req.body,
      })

      if (!creation.ok) {
        return res.status(creation.status).json({ error: creation.error })
      }

      return res.json({
        ok: true,
        signupId: creation.payload.signupId,
        userId: creation.payload.userId,
        role: creation.payload.role,
        message: 'Staff login account created successfully.',
      })
    } catch (err) {
      console.error('Failed to create staff account:', err.message)
      return res.status(500).json({ error: 'Failed to create staff account.' })
    }
  })

  // Update mentor/psychiatrist staff login account details.
  app.put('/api/admin/staff-accounts/:signupId', async (req, res) => {
    try {
      const parsedSignupId = Number(req.params.signupId)
      const updateResult = await updateStaffAccountBySignupId({
        dbPool,
        bcrypt,
        sanitizeRole,
        isStrongPassword,
        resolvePsychiatristTableMeta,
        signupId: parsedSignupId,
        body: req.body,
      })

      if (!updateResult.ok) {
        return res.status(updateResult.status).json({ error: updateResult.error })
      }

      return res.json({ ok: true, message: 'Staff account updated successfully.' })
    } catch (err) {
      console.error('Failed to update staff account:', err.message)
      return res.status(500).json({ error: 'Failed to update staff account.' })
    }
  })

  // Delete mentor/psychiatrist staff login accounts.
  app.delete('/api/admin/staff-accounts/:signupId', async (req, res) => {
    const parsedSignupId = Number(req.params.signupId)
    if (!Number.isInteger(parsedSignupId) || parsedSignupId <= 0) {
      return res.status(400).json({ error: 'Valid signupId is required.' })
    }

    try {
      const deletion = await deleteStaffAccountBySignupId({
        dbPool,
        sanitizeRole,
        resolvePsychiatristTableMeta,
        signupId: parsedSignupId,
      })

      if (!deletion.ok) {
        return res.status(deletion.status).json({ error: deletion.error })
      }

      return res.json({ ok: true, message: 'Staff account deleted successfully.' })
    } catch (err) {
      console.error('Failed to delete staff account:', err.message)
      return res.status(500).json({ error: 'Failed to delete staff account.' })
    }
  })

  setupMentorWorkspaceRoutes(app, dbPool, {
    ensureMentorWorkspaceSchema,
    resolveMentorWorkspaceId,
    parsePositiveInt,
    toIsoString,
  })

  setupMentorAvailabilityRoutes(app, dbPool, {
    ensureAppointmentSchema,
    resolveMentorWorkspaceId,
    parsePositiveInt,
    isWithinWorkingHours,
    toUtcDateFloor,
    ensureGeneratedAvailabilitySlots,
    toIsoString,
  })

  setupPsychiatristWorkspaceRoutes(app, dbPool, {
    ensurePsychiatristWorkspaceSchema,
    resolvePsychiatristWorkspaceId,
    parsePositiveInt,
    toIsoString,
  })

  setupPsychiatristAvailabilityReportRoutes(app, dbPool, {
    ensurePsychiatristWorkspaceSchema,
    ensureAppointmentSchema,
    resolvePsychiatristWorkspaceId,
    parsePositiveInt,
    toUtcDateFloor,
    ensureGeneratedAvailabilitySlots,
    toIsoString,
  })

  // Admin controls to block therapist availability for a full day.
  app.post('/api/therapists/block-day', async (req, res) => {
    try {
      const result = await updateTherapistDayAvailability({
        dbPool,
        ensureAppointmentSchema,
        normalizeTherapistType,
        resolveMentorWorkspaceId,
        resolvePsychiatristWorkspaceId,
        ensureGeneratedAvailabilitySlots,
        body: req.body,
        isAvailable: false,
      })

      if (!result.ok) return res.status(result.status).json({ error: result.error })
      return res.json({ ok: true, updatedSlots: result.updatedSlots })
    } catch (err) {
      console.error('Failed to block therapist day:', err.message)
      return res.status(500).json({ error: 'Failed to block day.' })
    }
  })

  // Admin controls to unblock therapist availability for a day.
  app.post('/api/therapists/unblock-day', async (req, res) => {
    try {
      const result = await updateTherapistDayAvailability({
        dbPool,
        ensureAppointmentSchema,
        normalizeTherapistType,
        resolveMentorWorkspaceId,
        resolvePsychiatristWorkspaceId,
        ensureGeneratedAvailabilitySlots,
        body: req.body,
        isAvailable: true,
      })

      if (!result.ok) return res.status(result.status).json({ error: result.error })
      return res.json({ ok: true, updatedSlots: result.updatedSlots })
    } catch (err) {
      console.error('Failed to unblock therapist day:', err.message)
      return res.status(500).json({ error: 'Failed to unblock day.' })
    }
  })

  // Register extracted admin operations routes (KPIs, complaints, resources, contacts).
  setupAdminOpsRoutes({
    app,
    dbPool,
    ensureAdminOpsSchema,
    parsePositiveInt,
    parseNonNegativeInt,
    parseNullablePhone,
    normalizeTherapistType,
    toIsoString,
    findLeastLoadedAssignee,
  })
}



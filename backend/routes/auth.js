const bcrypt = require('bcrypt')

const { sanitizeRole, roleToTable } = require('../config')
const { createSessionToken } = require('../auth/sessionToken')

// Build a readable fallback name from an email local-part.
function buildDisplayName(email) {
  const localPart = String(email || '').split('@')[0] || 'User'
  const cleaned = localPart.replace(/[._-]+/g, ' ').trim()
  if (!cleaned) return 'User'
  return cleaned
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

// Generate a unique student username seed from email.
function buildStudentUsername(email) {
  const localPart = String(email || '').split('@')[0] || 'student'
  const base = localPart.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'student'
  const suffix = Date.now().toString().slice(-6)
  return `${base}_${suffix}`
}

// Map role name to its primary key column.
function roleIdColumn(role) {
  if (role === 'student') return 'student_id'
  if (role === 'mentor') return 'mentor_id'
  if (role === 'psychiatrist') return 'psychiatrist_id'
  if (role === 'admin') return 'admin_id'
  return null
}

// Map role to its dashboard route.
function dashboardPath(role) {
  if (role === 'student') return 'student.html'
  if (role === 'mentor') return 'mentor.html'
  if (role === 'psychiatrist') return 'psychologist.html'
  if (role === 'admin') return 'admin.html'
  return 'account.html'
}

// Map role to its profile-completion route.
function profilePath(role) {
  if (role === 'student') return 'profile-student.html'
  if (role === 'mentor') return 'profile-mentor.html'
  if (role === 'psychiatrist') return 'profile-psychiatrist.html'
  if (role === 'admin') return 'admin.html'
  return 'account.html'
}

function isStrongPassword(password) {
  // At least 7 chars, uppercase, lowercase, and special char.
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{7,}$/.test(String(password || ''))
}

function parsePositiveInt(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}

function parseNullablePhone(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return null

  const digits = raw.replace(/\D+/g, '')
  if (!digits) return null

  const parsed = Number(digits)
  if (!Number.isFinite(parsed)) return null
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}

function parseNonNegativeInt(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) return null
  return parsed
}

// Schema helpers used to handle mixed legacy/current DB variants.
async function tableExists(db, tableName) {
  const result = await db.query('SELECT to_regclass($1) AS reg', [`public.${String(tableName || '').trim()}`])
  return Boolean(result.rows[0] && result.rows[0].reg)
}

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

// Normalize therapist labels used by clients.
function normalizeTherapistType(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()

  if (normalized === 'mentor') return 'mentor'
  if (normalized === 'psychiatrist' || normalized === 'psychologist') return 'psychiatrist'
  return null
}

function toUtcDateFloor(dateInput) {
  const date = new Date(dateInput)
  if (Number.isNaN(date.getTime())) return null
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0))
}

function toIsoString(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function isWithinWorkingHours(startAt, endAt) {
  const start = new Date(startAt)
  const end = new Date(endAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false
  if (end <= start) return false

  const startDay = start.getDay()
  const endDay = end.getDay()
  if (startDay !== endDay) return false
  if (startDay === 0) return false

  const startMinutes = (start.getHours() * 60) + start.getMinutes()
  const endMinutes = (end.getHours() * 60) + end.getMinutes()

  if (startDay === 6) {
    return startMinutes >= 10 * 60 && endMinutes <= 14 * 60
  }

  return startMinutes >= 9 * 60 && endMinutes <= 17 * 60
}

function getWorkingWindowByDay(dayOfWeek) {
  if (dayOfWeek === 0) return null
  if (dayOfWeek === 6) return { startHour: 10, endHour: 14 }
  return { startHour: 9, endHour: 17 }
}

// Auto-generate 1-hour availability slots for a therapist in a date range.
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

// Ensure appointment and availability tables/indexes exist.
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

// Ensure journal storage exists.
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

// Ensure admin operations tables (resources, contacts, KPI overrides, complaints) exist.
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

  const defaultEmergencyContacts = [
    { contactName: 'Emergency Services', phoneNo: 999 },
    { contactName: 'Befrienders Kenya', phoneNo: 722178177 },
    { contactName: 'Strathmore Counselling', phoneNo: 700000000 },
  ]

  for (const contact of defaultEmergencyContacts) {
    await dbPool.query(
      `
      INSERT INTO emergency_contact (conatct_name, contact_name, phone_no, student_id)
      SELECT $1, $1, $2, NULL
      WHERE NOT EXISTS (
        SELECT 1
        FROM emergency_contact
        WHERE LOWER(COALESCE(contact_name, conatct_name, '')) = LOWER($1)
          AND student_id IS NULL
      )
      `,
      [contact.contactName, contact.phoneNo]
    )
  }

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

// Ensure mentor workspace tables exist.
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

// Ensure psychiatrist workspace tables exist (supports legacy table variants).
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

// Resolve mentor identifier from either mentor_id or signup_id.
async function resolveMentorWorkspaceId(dbPool, rawId) {
  const numericId = parsePositiveInt(rawId)
  if (!numericId) return null

  const byMentorId = await dbPool.query('SELECT mentor_id FROM mentor WHERE mentor_id = $1 LIMIT 1', [numericId])
  if (byMentorId.rows[0]) return Number(byMentorId.rows[0].mentor_id)

  const bySignupId = await dbPool.query('SELECT mentor_id FROM mentor WHERE signup_id = $1 LIMIT 1', [numericId])
  if (bySignupId.rows[0]) return Number(bySignupId.rows[0].mentor_id)

  return null
}

// Resolve psychiatrist identifier from either psychiatrist_id or signup_id.
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

function normalizeAnswer(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function normalizeAnswerSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
  )
}

// Compute assignment preference scores from questionnaire answers.
function computeAssignmentDecision(answers) {
  const periodAffected = normalizeAnswer(answers.period_affected)
  const supportType = normalizeAnswer(answers.support_type)
  const supportPreferences = normalizeAnswer(answers.support_preferences)
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

  if (mentorPreferenceOptions.has(supportPreferences)) mentorScore += 1
  if (psychiatristPreferenceOptions.has(supportPreferences)) psychiatristScore += 1

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

// Select the least-loaded assignee by role.
async function findLeastLoadedAssignee(dbPool, role) {
  if (role === 'mentor') {
    const result = await dbPool.query(
      `
      SELECT m.mentor_id AS assignee_id, COUNT(a.assignment_id)::int AS assigned_count
      FROM mentor m
      LEFT JOIN assignments a ON a.mentor_id = m.mentor_id
      GROUP BY m.mentor_id
      HAVING COUNT(a.assignment_id) < 4
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
      HAVING COUNT(a.assignment_id) < 4
      ORDER BY assigned_count ASC, p.psychiatrist_id ASC
      LIMIT 1
      `
    )
    return result.rows[0] ? Number(result.rows[0].assignee_id) : null
  }

  return null
}

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

// Ensure questionnaire and assignments schema supports all current/legacy writes.
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

// Resolve student identity from student_id or signup_id, auto-creating profile row if needed.
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

// Repair missing auto-increment defaults on role profile IDs.
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

async function syncLegacyStudentTableIfPresent(dbPool, studentId) {
  return
}

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

// Create missing profile rows for each role during profile completion.
async function ensureRoleProfileRow(dbPool, { role, table, userIdCol, signupId, email }) {
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

    const fullName = buildDisplayName(email)
    const sql = `
      INSERT INTO ${table} (signup_id, email, full_name)
      VALUES ($1, $2, $3)
      RETURNING ${userIdCol}
    `
    const row = await dbPool.query(sql, [signupId, email, fullName])
    return String(row.rows[0][userIdCol])
  }

  return null
}

// Resolve existing role profile row and repair signup linkage when safe.
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

// Register all auth, profile, assignment, scheduling, admin, and workspace routes.
function setupAuthRoutes(app, dbPool) {
  // Resolve a user ID from role + identifier (email/name/id) for client utilities.
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

  // List therapists by type for booking and selection UIs.
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

  // Fetch generated therapist availability slots within a date range.
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

  // Book an appointment against an available slot with transactional locking.
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

  // List upcoming booked appointments for a therapist.
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

  // Student signup (creates signup row; profile completion happens later).
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
      const userIdCol = roleIdColumn(normalizedRole)
      if (!userIdCol) return res.status(400).json({ error: 'Invalid role' })

      const roleRow = await resolveRoleRow(dbPool, normalizedRole)
      if (!roleRow) return res.status(400).json({ error: 'Role mapping missing in roles table.' })

      await ensurePasswordHashColumn(dbPool, table)

      const existingSignup = await dbPool.query(
        'SELECT signup_id FROM signup WHERE email = $1 AND role_id = $2 LIMIT 1',
        [email, Number(roleRow.role_id)]
      )
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

  // Login and determine redirect by role/profile/questionnaire state.
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

  // Save questionnaire answers and upsert assignment decision.
  app.post('/api/questionnaire', async (req, res) => {
    try {
      const { studentId, answers } = req.body || {}
      const parsedStudentId = Number(studentId)
      if (!Number.isInteger(parsedStudentId) || parsedStudentId <= 0) {
        return res.status(400).json({ error: 'Valid studentId is required' })
      }
      if (!answers || typeof answers !== 'object') {
        return res.status(400).json({ error: 'Questionnaire answers are required' })
      }

      await ensureQuestionnaireWriteSchema(dbPool)

      const requiredFields = [
        'mentalHealthSupport',
        'concerns',
        'period_affected',
        'support_type',
        'support_preferences',
        'religion',
        'religion_type',
        'spiritual_status',
        'therapy_status',
        'seek_support',
        'expectations',
        'session_structure',
        'communication',
      ]

      const missingField = requiredFields.find((field) => !String(answers[field] || '').trim())
      if (missingField) {
        return res.status(400).json({ error: `Missing questionnaire field: ${missingField}` })
      }

      const resolvedStudentId = await resolveStudentIdForQuestionnaire(dbPool, parsedStudentId)
      if (!resolvedStudentId) {
        return res.status(400).json({ error: 'Could not resolve student profile for questionnaire submission' })
      }

      await syncLegacyStudentTableIfPresent(dbPool, resolvedStudentId)

      const studentResult = await dbPool.query('SELECT username FROM student WHERE student_id = $1 LIMIT 1', [resolvedStudentId])
      if (!studentResult.rows[0]) {
        return res.status(404).json({ error: 'Student profile not found' })
      }

      const decision = computeAssignmentDecision(answers)
      const assigneeRole = decision.assignedRole

      const existingAssignment = await dbPool.query(
        `
        SELECT mentor_id, psychiatrist_id
        FROM assignments
        WHERE student_id = $1
        LIMIT 1
        `,
        [resolvedStudentId]
      )

      const existing = existingAssignment.rows[0] || {}
      const existingAssigneeId =
        assigneeRole === 'mentor'
          ? (existing.mentor_id != null ? Number(existing.mentor_id) : null)
          : assigneeRole === 'psychiatrist'
            ? (existing.psychiatrist_id != null ? Number(existing.psychiatrist_id) : null)
            : null

      const assigneeId = assigneeRole
        ? (existingAssigneeId != null ? existingAssigneeId : await findLeastLoadedAssignee(dbPool, assigneeRole))
        : null

      if (assigneeRole && assigneeId == null) {
        return res.status(409).json({ error: `No available ${assigneeRole} currently. Please try again shortly.` })
      }

      const mentorId =
        assigneeRole === 'mentor' && assigneeId != null
          ? await resolveQuestionnaireAssigneeId(dbPool, 'mentor', assigneeId)
          : null
      const psychiatristId =
        assigneeRole === 'psychiatrist' && assigneeId != null
          ? await resolveQuestionnaireAssigneeId(dbPool, 'psychiatrist', assigneeId)
          : null

      const legacyAnswersJsonCheck = await dbPool.query(
        `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'questionnaire'
            AND column_name = 'answers_json'
        ) AS exists
        `
      )
      const hasLegacyAnswersJson = Boolean(legacyAnswersJsonCheck.rows[0] && legacyAnswersJsonCheck.rows[0].exists)

      const legacyUpdatedAtCheck = await dbPool.query(
        `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'questionnaire'
            AND column_name = 'updated_at'
        ) AS exists
        `
      )
      const hasLegacyUpdatedAt = Boolean(legacyUpdatedAtCheck.rows[0] && legacyUpdatedAtCheck.rows[0].exists)

      const legacySupportPreferenceCheck = await dbPool.query(
        `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'questionnaire'
            AND column_name = 'support_preference'
        ) AS exists
        `
      )
      const hasLegacySupportPreference = Boolean(
        legacySupportPreferenceCheck.rows[0] && legacySupportPreferenceCheck.rows[0].exists
      )

      const structuredValues = [
        resolvedStudentId,
        String(answers.mentalHealthSupport),
        String(answers.concerns),
        String(answers.period_affected),
        String(answers.support_type),
        String(answers.support_preferences),
        String(answers.religion),
        String(answers.religion_type),
        String(answers.spiritual_status),
        String(answers.therapy_status),
        String(answers.seek_support),
        String(answers.expectations),
        String(answers.session_structure),
        String(answers.communication),
        mentorId,
        psychiatristId,
      ]

      if (hasLegacyAnswersJson && hasLegacyUpdatedAt) {
        await dbPool.query(
          `
          INSERT INTO questionnaire (
            student_id,
            mentalhealthsupport,
            concerns,
            period_affected,
            support_type,
            support_preferences,
            religion,
            religion_type,
            spiritual_status,
            therapy_status,
            seek_support,
            expectations,
            session_structure,
            communication,
            mentor_id,
            psychiatrist_id,
            answers_json,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, NOW(), NOW())
          ON CONFLICT (student_id)
          DO UPDATE SET
            mentalhealthsupport = EXCLUDED.mentalhealthsupport,
            concerns = EXCLUDED.concerns,
            period_affected = EXCLUDED.period_affected,
            support_type = EXCLUDED.support_type,
            support_preferences = EXCLUDED.support_preferences,
            religion = EXCLUDED.religion,
            religion_type = EXCLUDED.religion_type,
            spiritual_status = EXCLUDED.spiritual_status,
            therapy_status = EXCLUDED.therapy_status,
            seek_support = EXCLUDED.seek_support,
            expectations = EXCLUDED.expectations,
            session_structure = EXCLUDED.session_structure,
            communication = EXCLUDED.communication,
            mentor_id = EXCLUDED.mentor_id,
            psychiatrist_id = EXCLUDED.psychiatrist_id,
            answers_json = EXCLUDED.answers_json,
            updated_at = NOW()
          `,
          [...structuredValues, JSON.stringify(answers)]
        )
      } else if (hasLegacyAnswersJson) {
        await dbPool.query(
          `
          INSERT INTO questionnaire (
            student_id,
            mentalhealthsupport,
            concerns,
            period_affected,
            support_type,
            support_preferences,
            religion,
            religion_type,
            spiritual_status,
            therapy_status,
            seek_support,
            expectations,
            session_structure,
            communication,
            mentor_id,
            psychiatrist_id,
            answers_json,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, NOW())
          ON CONFLICT (student_id)
          DO UPDATE SET
            mentalhealthsupport = EXCLUDED.mentalhealthsupport,
            concerns = EXCLUDED.concerns,
            period_affected = EXCLUDED.period_affected,
            support_type = EXCLUDED.support_type,
            support_preferences = EXCLUDED.support_preferences,
            religion = EXCLUDED.religion,
            religion_type = EXCLUDED.religion_type,
            spiritual_status = EXCLUDED.spiritual_status,
            therapy_status = EXCLUDED.therapy_status,
            seek_support = EXCLUDED.seek_support,
            expectations = EXCLUDED.expectations,
            session_structure = EXCLUDED.session_structure,
            communication = EXCLUDED.communication,
            mentor_id = EXCLUDED.mentor_id,
            psychiatrist_id = EXCLUDED.psychiatrist_id,
            answers_json = EXCLUDED.answers_json
          `,
          [...structuredValues, JSON.stringify(answers)]
        )
      } else if (hasLegacyUpdatedAt) {
        await dbPool.query(
          `
          INSERT INTO questionnaire (
            student_id,
            mentalhealthsupport,
            concerns,
            period_affected,
            support_type,
            support_preferences,
            religion,
            religion_type,
            spiritual_status,
            therapy_status,
            seek_support,
            expectations,
            session_structure,
            communication,
            mentor_id,
            psychiatrist_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
          ON CONFLICT (student_id)
          DO UPDATE SET
            mentalhealthsupport = EXCLUDED.mentalhealthsupport,
            concerns = EXCLUDED.concerns,
            period_affected = EXCLUDED.period_affected,
            support_type = EXCLUDED.support_type,
            support_preferences = EXCLUDED.support_preferences,
            religion = EXCLUDED.religion,
            religion_type = EXCLUDED.religion_type,
            spiritual_status = EXCLUDED.spiritual_status,
            therapy_status = EXCLUDED.therapy_status,
            seek_support = EXCLUDED.seek_support,
            expectations = EXCLUDED.expectations,
            session_structure = EXCLUDED.session_structure,
            communication = EXCLUDED.communication,
            mentor_id = EXCLUDED.mentor_id,
            psychiatrist_id = EXCLUDED.psychiatrist_id,
            updated_at = NOW()
          `,
          structuredValues
        )
      } else {
        await dbPool.query(
          `
          INSERT INTO questionnaire (
            student_id,
            mentalhealthsupport,
            concerns,
            period_affected,
            support_type,
            support_preferences,
            religion,
            religion_type,
            spiritual_status,
            therapy_status,
            seek_support,
            expectations,
            session_structure,
            communication,
            mentor_id,
            psychiatrist_id,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
          ON CONFLICT (student_id)
          DO UPDATE SET
            mentalhealthsupport = EXCLUDED.mentalhealthsupport,
            concerns = EXCLUDED.concerns,
            period_affected = EXCLUDED.period_affected,
            support_type = EXCLUDED.support_type,
            support_preferences = EXCLUDED.support_preferences,
            religion = EXCLUDED.religion,
            religion_type = EXCLUDED.religion_type,
            spiritual_status = EXCLUDED.spiritual_status,
            therapy_status = EXCLUDED.therapy_status,
            seek_support = EXCLUDED.seek_support,
            expectations = EXCLUDED.expectations,
            session_structure = EXCLUDED.session_structure,
            communication = EXCLUDED.communication,
            mentor_id = EXCLUDED.mentor_id,
            psychiatrist_id = EXCLUDED.psychiatrist_id
          `,
          structuredValues
        )
      }

      if (hasLegacySupportPreference) {
        await dbPool.query('UPDATE questionnaire SET support_preference = $1 WHERE student_id = $2', [
          String(answers.support_preferences),
          resolvedStudentId,
        ])
      }

      await dbPool.query(
        `
        INSERT INTO assignments (username, student_id, mentor_id, psychiatrist_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (student_id)
        DO UPDATE SET
          username = EXCLUDED.username,
          student_id = EXCLUDED.student_id,
          mentor_id = EXCLUDED.mentor_id,
          psychiatrist_id = EXCLUDED.psychiatrist_id
        `,
        [studentResult.rows[0].username, resolvedStudentId, mentorId, psychiatristId]
      )

      const assignedTo = mentorId != null ? 'mentor' : psychiatristId != null ? 'psychiatrist' : null

      return res.json({
        ok: true,
        message: 'Questionnaire saved successfully.',
        assignedTo,
        mentorScore: decision.mentorScore,
        psychiatristScore: decision.psychiatristScore,
      })
    } catch (err) {
      console.error('Questionnaire save failed:', err.message)
      return res.status(500).json({ error: 'Failed to save questionnaire.' })
    }
  })

  // Create or update role profile details.
  app.post('/api/profile', async (req, res) => {
    try {
      const {
        signupId,
        role,
        fullName,
        username,
        studentId,
        gender,
        phoneNo,
        modeOfPayment,
        certification,
        licenceNumber,
        yearsOfExperience,
        billingDetails,
        bio,
        contactId,
        resourceId,
      } = req.body || {}
      const normalizedRole = sanitizeRole(role)
      const parsedSignupId = Number(signupId)

      if (!normalizedRole) return res.status(400).json({ error: 'Invalid role' })
      if (!Number.isInteger(parsedSignupId) || parsedSignupId <= 0) {
        return res.status(400).json({ error: 'Valid signupId is required' })
      }

      const signupRow = await dbPool.query(
        `
        SELECT signup_id, email, role, role_name, password_hash
        FROM signup
        WHERE signup_id = $1
        LIMIT 1
        `,
        [parsedSignupId]
      )
      if (!signupRow.rows[0]) return res.status(404).json({ error: 'Signup account not found' })

      const signup = signupRow.rows[0]
      const signupRole = sanitizeRole(signup.role || signup.role_name)
      if (signupRole !== normalizedRole) {
        return res.status(400).json({ error: 'Role does not match signup account' })
      }

      const email = String(signup.email || '')
      const passwordHash = String(signup.password_hash || '')

      let profileUserId = null
      if (normalizedRole === 'student') {
        await ensureStudentIdAutoIncrement(dbPool)

        const safeFullName = String(fullName || '').trim() || buildDisplayName(email)
        const safeUsername = String(username || '').trim() || buildStudentUsername(email)
        const safeStudentIdentifier = String(studentId || '').trim() || null
        const safeGender = String(gender || '').trim() || null
        const safePhoneNo = parseNullablePhone(phoneNo)
        const safeModeOfPayment = String(modeOfPayment || '').trim() || null

        await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS full_name VARCHAR(100)')
        await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)')
        await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS student_identifier VARCHAR(50)')
        await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS gender VARCHAR(20)')
        await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS phone_no BIGINT')
        await dbPool.query('ALTER TABLE student ALTER COLUMN phone_no TYPE BIGINT USING phone_no::BIGINT')
        await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS mode_of_payment VARCHAR(50)')
        await dbPool.query('ALTER TABLE student DROP COLUMN IF EXISTS questionnaire')

        const studentUpsert = await dbPool.query(
          `
          INSERT INTO student (
            signup_id, full_name, email, username, password_hash, student_identifier, gender, phone_no, mode_of_payment
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (signup_id)
          DO UPDATE SET
            full_name = EXCLUDED.full_name,
            email = EXCLUDED.email,
            username = EXCLUDED.username,
            password_hash = EXCLUDED.password_hash,
            student_identifier = EXCLUDED.student_identifier,
            gender = EXCLUDED.gender,
            phone_no = EXCLUDED.phone_no,
            mode_of_payment = EXCLUDED.mode_of_payment
          RETURNING student_id
          `,
          [
            parsedSignupId,
            safeFullName,
            email,
            safeUsername,
            passwordHash,
            safeStudentIdentifier,
            safeGender,
            safePhoneNo,
            safeModeOfPayment,
          ]
        )

        profileUserId = String(studentUpsert.rows[0].student_id)
        await syncLegacyStudentTableIfPresent(dbPool, Number(profileUserId))
      } else if (normalizedRole === 'mentor' || normalizedRole === 'psychiatrist') {
        const safeFullName = String(fullName || '').trim() || buildDisplayName(email)
        const safePhoneNo = parseNullablePhone(phoneNo)

        if (normalizedRole === 'mentor') {
          const safeBio = String(bio || '').trim() || null

          await ensureMentorIdAutoIncrement(dbPool)
          await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)')
          await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS phone_no BIGINT')
          await dbPool.query('ALTER TABLE mentor ALTER COLUMN phone_no TYPE BIGINT USING phone_no::BIGINT')
          await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS bio VARCHAR(100)')
          await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS student_id INT')

          const mentorUpsert = await dbPool.query(
            `
            INSERT INTO mentor (signup_id, full_name, email, password_hash, phone_no, bio, student_id)
            VALUES ($1, $2, $3, $4, $5, $6, NULL)
            ON CONFLICT (signup_id)
            DO UPDATE SET
              full_name = EXCLUDED.full_name,
              email = EXCLUDED.email,
              password_hash = EXCLUDED.password_hash,
              phone_no = EXCLUDED.phone_no,
              bio = EXCLUDED.bio
            RETURNING mentor_id
            `,
            [parsedSignupId, safeFullName, email, passwordHash, safePhoneNo, safeBio]
          )

          profileUserId = String(mentorUpsert.rows[0].mentor_id)
        } else {
          const safeCertification = String(certification || '').trim() || null
          const safeLicenceNumber = String(licenceNumber || '').trim() || null
          const yearsValue = Number(yearsOfExperience)
          const safeYearsOfExperience =
            yearsOfExperience == null || String(yearsOfExperience).trim() === ''
              ? null
              : Number.isInteger(yearsValue) && yearsValue >= 0
                ? yearsValue
                : null
          const safeBillingDetails = String(billingDetails || '').trim() || null

          await ensurePsychiatristIdAutoIncrement(dbPool)
          await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)')
          await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS phone_no BIGINT')
          await dbPool.query('ALTER TABLE psychiatrist ALTER COLUMN phone_no TYPE BIGINT USING phone_no::BIGINT')
          await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS certification VARCHAR(100)')
          await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS licence_number VARCHAR(100)')
          await dbPool.query('ALTER TABLE psychiatrist ALTER COLUMN licence_number TYPE VARCHAR(100) USING licence_number::TEXT')
          await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS years_of_experience INT')
          await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS billing_details VARCHAR(255)')
          await dbPool.query('ALTER TABLE psychiatrist ALTER COLUMN billing_details TYPE VARCHAR(255)')
          await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS student_id INT')

          const psychiatristUpsert = await dbPool.query(
            `
            INSERT INTO psychiatrist (
              signup_id,
              full_name,
              email,
              password_hash,
              phone_no,
              certification,
              licence_number,
              years_of_experience,
              billing_details,
              student_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
            ON CONFLICT (signup_id)
            DO UPDATE SET
              full_name = EXCLUDED.full_name,
              email = EXCLUDED.email,
              password_hash = EXCLUDED.password_hash,
              phone_no = EXCLUDED.phone_no,
              certification = EXCLUDED.certification,
              licence_number = EXCLUDED.licence_number,
              years_of_experience = EXCLUDED.years_of_experience,
              billing_details = EXCLUDED.billing_details
            RETURNING psychiatrist_id
            `,
            [
              parsedSignupId,
              safeFullName,
              email,
              passwordHash,
              safePhoneNo,
              safeCertification,
              safeLicenceNumber,
              safeYearsOfExperience,
              safeBillingDetails,
            ]
          )

          profileUserId = String(psychiatristUpsert.rows[0].psychiatrist_id)
        }
      } else if (normalizedRole === 'admin') {
        const safeContactId = contactId == null || String(contactId).trim() === '' ? null : Number(contactId)
        const safeResourceId = resourceId == null || String(resourceId).trim() === '' ? null : Number(resourceId)

        await dbPool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS signup_id INT UNIQUE')

        const adminExisting = await dbPool.query('SELECT admin_id FROM admins WHERE signup_id = $1 LIMIT 1', [parsedSignupId])

        if (adminExisting.rows[0]) {
          const updated = await dbPool.query(
            `
            UPDATE admins
            SET password_hash = $1,
                contact_id = $2,
                resource_id = $3
            WHERE signup_id = $4
            RETURNING admin_id
            `,
            [passwordHash, safeContactId, safeResourceId, parsedSignupId]
          )
          profileUserId = String(updated.rows[0].admin_id)
        } else {
          const created = await dbPool.query(
            `
            INSERT INTO admins (password_hash, contact_id, resource_id, signup_id)
            VALUES ($1, $2, $3, $4)
            RETURNING admin_id
            `,
            [passwordHash, safeContactId, safeResourceId, parsedSignupId]
          )
          profileUserId = String(created.rows[0].admin_id)
        }
      }

      if (!profileUserId) return res.status(500).json({ error: 'Failed to create profile' })

      let redirectTo = dashboardPath(normalizedRole)
      let needsQuestionnaire = false
      if (normalizedRole === 'student') {
        const q = await dbPool.query('SELECT questionnaire_id FROM questionnaire WHERE student_id = $1 LIMIT 1', [Number(profileUserId)])
        needsQuestionnaire = !q.rows[0]
        redirectTo = needsQuestionnaire ? 'questionnaire.html' : 'student.html'
      }

      const sessionToken = createSessionToken({ userId: profileUserId, role: normalizedRole })

      return res.json({
        ok: true,
        role: normalizedRole,
        signupId: String(parsedSignupId),
        userId: profileUserId,
        sessionToken,
        profileComplete: true,
        needsQuestionnaire,
        redirectTo,
      })
    } catch (err) {
      console.error('Profile save failed:', err.message)
      return res.status(500).json({ error: 'Failed to save profile' })
    }
  })

  // Fetch role profile details by signup account.
  app.get('/api/profile', async (req, res) => {
    try {
      const normalizedRole = sanitizeRole(req.query.role)
      const parsedSignupId = Number(req.query.signupId)

      if (!normalizedRole) return res.status(400).json({ error: 'Invalid role' })
      if (!Number.isInteger(parsedSignupId) || parsedSignupId <= 0) {
        return res.status(400).json({ error: 'Valid signupId is required' })
      }

      const signupRow = await dbPool.query(
        `
        SELECT signup_id, role, role_name
        FROM signup
        WHERE signup_id = $1
        LIMIT 1
        `,
        [parsedSignupId]
      )

      if (!signupRow.rows[0]) return res.status(404).json({ error: 'Signup account not found' })

      const signupRole = sanitizeRole(signupRow.rows[0].role || signupRow.rows[0].role_name)
      if (signupRole !== normalizedRole) {
        return res.status(400).json({ error: 'Role does not match signup account' })
      }

      if (normalizedRole === 'student') {
        await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS full_name VARCHAR(100)')
        await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS student_identifier VARCHAR(50)')
        await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS gender VARCHAR(20)')
        await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS phone_no INT')
        await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS mode_of_payment VARCHAR(50)')

        const result = await dbPool.query(
          `
          SELECT
            student_id,
            full_name,
            username,
            student_identifier,
            gender,
            phone_no,
            mode_of_payment
          FROM student
          WHERE signup_id = $1
          LIMIT 1
          `,
          [parsedSignupId]
        )

        if (!result.rows[0]) {
          return res.json({ ok: true, role: normalizedRole, signupId: String(parsedSignupId), exists: false, profile: {} })
        }

        const row = result.rows[0]
        return res.json({
          ok: true,
          role: normalizedRole,
          signupId: String(parsedSignupId),
          userId: String(row.student_id),
          exists: true,
          profile: {
            fullName: row.full_name || '',
            username: row.username || '',
            studentId: row.student_identifier || '',
            gender: row.gender || '',
            phoneNo: row.phone_no == null ? '' : String(row.phone_no),
            modeOfPayment: row.mode_of_payment || '',
          },
        })
      }

      if (normalizedRole === 'mentor') {
        await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS phone_no INT')
        await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS bio VARCHAR(100)')

        const result = await dbPool.query(
          `
          SELECT mentor_id, full_name, phone_no, bio
          FROM mentor
          WHERE signup_id = $1
          LIMIT 1
          `,
          [parsedSignupId]
        )

        if (!result.rows[0]) {
          return res.json({ ok: true, role: normalizedRole, signupId: String(parsedSignupId), exists: false, profile: {} })
        }

        const row = result.rows[0]
        return res.json({
          ok: true,
          role: normalizedRole,
          signupId: String(parsedSignupId),
          userId: String(row.mentor_id),
          exists: true,
          profile: {
            fullName: row.full_name || '',
            phoneNo: row.phone_no == null ? '' : String(row.phone_no),
            bio: row.bio || '',
          },
        })
      }

      if (normalizedRole === 'psychiatrist') {
        await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS phone_no BIGINT')
        await dbPool.query('ALTER TABLE psychiatrist ALTER COLUMN phone_no TYPE BIGINT USING phone_no::BIGINT')
        await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS certification VARCHAR(100)')
        await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS licence_number VARCHAR(100)')
        await dbPool.query('ALTER TABLE psychiatrist ALTER COLUMN licence_number TYPE VARCHAR(100) USING licence_number::TEXT')
        await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS years_of_experience INT')
        await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS billing_details VARCHAR(255)')
        await dbPool.query('ALTER TABLE psychiatrist ALTER COLUMN billing_details TYPE VARCHAR(255)')

        const result = await dbPool.query(
          `
          SELECT
            psychiatrist_id,
            full_name,
            phone_no,
            certification,
            licence_number,
            years_of_experience,
            billing_details
          FROM psychiatrist
          WHERE signup_id = $1
          LIMIT 1
          `,
          [parsedSignupId]
        )

        if (!result.rows[0]) {
          return res.json({ ok: true, role: normalizedRole, signupId: String(parsedSignupId), exists: false, profile: {} })
        }

        const row = result.rows[0]
        return res.json({
          ok: true,
          role: normalizedRole,
          signupId: String(parsedSignupId),
          userId: String(row.psychiatrist_id),
          exists: true,
          profile: {
            fullName: row.full_name || '',
            phoneNo: row.phone_no == null ? '' : String(row.phone_no),
            certification: row.certification || '',
            licenceNumber: row.licence_number == null ? '' : String(row.licence_number),
            yearsOfExperience: row.years_of_experience == null ? '' : String(row.years_of_experience),
            billingDetails: row.billing_details || '',
          },
        })
      }

      if (normalizedRole === 'admin') {
        await dbPool.query(
          `
          CREATE TABLE IF NOT EXISTS admins (
            admin_id SERIAL PRIMARY KEY,
            password_hash VARCHAR(255),
            contact_id INT,
            resource_id INT,
            signup_id INT UNIQUE
          )
          `
        )

        const result = await dbPool.query(
          `
          SELECT admin_id, contact_id, resource_id
          FROM admins
          WHERE signup_id = $1
          LIMIT 1
          `,
          [parsedSignupId]
        )

        if (!result.rows[0]) {
          return res.json({ ok: true, role: normalizedRole, signupId: String(parsedSignupId), exists: false, profile: {} })
        }

        const row = result.rows[0]
        return res.json({
          ok: true,
          role: normalizedRole,
          signupId: String(parsedSignupId),
          userId: String(row.admin_id),
          exists: true,
          profile: {
            contactId: row.contact_id == null ? '' : String(row.contact_id),
            resourceId: row.resource_id == null ? '' : String(row.resource_id),
          },
        })
      }

      return res.status(400).json({ error: 'Role not supported for profile lookup' })
    } catch (err) {
      console.error('Profile fetch failed:', err.message)
      return res.status(500).json({ error: 'Failed to load profile' })
    }
  })

  // Delete account/profile with role-specific cleanup.
  app.delete('/api/profile', async (req, res) => {
    const normalizedRole = sanitizeRole(req.body?.role)
    const parsedSignupId = Number(req.body?.signupId)

    if (!normalizedRole) return res.status(400).json({ error: 'Invalid role' })
    if (!Number.isInteger(parsedSignupId) || parsedSignupId <= 0) {
      return res.status(400).json({ error: 'Valid signupId is required' })
    }

    const client = await dbPool.connect()
    try {
      await client.query('BEGIN')

      const signupRow = await client.query(
        `
        SELECT signup_id, role, role_name
        FROM signup
        WHERE signup_id = $1
        LIMIT 1
        `,
        [parsedSignupId]
      )
      if (!signupRow.rows[0]) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Signup account not found' })
      }

      const signupRole = sanitizeRole(signupRow.rows[0].role || signupRow.rows[0].role_name)
      if (signupRole !== normalizedRole) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Role does not match signup account' })
      }

      const hasMessages = await tableExists(client, 'messages')
      const hasAssignments = await tableExists(client, 'assignments')
      const hasQuestionnaire = await tableExists(client, 'questionnaire')
      const hasAppointments = await tableExists(client, 'appointments')
      const hasAvailability = await tableExists(client, 'therapist_availability')
      const hasJournal = await tableExists(client, 'journal')

      if (normalizedRole === 'student') {
        const studentRow = await client.query('SELECT student_id FROM student WHERE signup_id = $1 LIMIT 1', [parsedSignupId])
        if (studentRow.rows[0]) {
          const studentId = Number(studentRow.rows[0].student_id)
          if (hasMessages) {
            await client.query('DELETE FROM messages WHERE student_id = $1', [studentId])
          }
          if (hasAssignments) {
            await client.query('DELETE FROM assignments WHERE student_id = $1', [studentId])
          }
          if (hasJournal) {
            await client.query('DELETE FROM journal WHERE student_id = $1', [studentId])
          }
          if (hasAppointments) {
            await client.query('DELETE FROM appointments WHERE student_id = $1', [studentId])
          }
          await client.query('DELETE FROM student WHERE student_id = $1', [studentId])
        }
      }

      if (normalizedRole === 'mentor') {
        const mentorRow = await client.query('SELECT mentor_id FROM mentor WHERE signup_id = $1 LIMIT 1', [parsedSignupId])
        if (mentorRow.rows[0]) {
          const mentorId = Number(mentorRow.rows[0].mentor_id)
          if (hasMessages) {
            await client.query('DELETE FROM messages WHERE mentor_id = $1', [mentorId])
          }
          if (hasAssignments) {
            await client.query('UPDATE assignments SET mentor_id = NULL WHERE mentor_id = $1', [mentorId])
          }
          if (hasQuestionnaire) {
            await client.query('UPDATE questionnaire SET mentor_id = NULL WHERE mentor_id = $1', [mentorId])
          }
          if (hasAppointments) {
            await client.query("DELETE FROM appointments WHERE therapist_type = 'mentor' AND therapist_id = $1", [mentorId])
          }
          if (hasAvailability) {
            await client.query("DELETE FROM therapist_availability WHERE therapist_type = 'mentor' AND therapist_id = $1", [mentorId])
          }
          await client.query('DELETE FROM mentor WHERE mentor_id = $1', [mentorId])
        }
      }

      if (normalizedRole === 'psychiatrist') {
        const psychiatristRow = await client.query('SELECT psychiatrist_id FROM psychiatrist WHERE signup_id = $1 LIMIT 1', [parsedSignupId])
        if (psychiatristRow.rows[0]) {
          const psychiatristId = Number(psychiatristRow.rows[0].psychiatrist_id)
          if (hasMessages) {
            await client.query('DELETE FROM messages WHERE psychiatrist_id = $1', [psychiatristId])
          }
          if (hasAssignments) {
            await client.query('UPDATE assignments SET psychiatrist_id = NULL WHERE psychiatrist_id = $1', [psychiatristId])
          }
          if (hasQuestionnaire) {
            await client.query('UPDATE questionnaire SET psychiatrist_id = NULL WHERE psychiatrist_id = $1', [psychiatristId])
          }
          if (hasAppointments) {
            await client.query("DELETE FROM appointments WHERE therapist_type = 'psychiatrist' AND therapist_id = $1", [psychiatristId])
          }
          if (hasAvailability) {
            await client.query("DELETE FROM therapist_availability WHERE therapist_type = 'psychiatrist' AND therapist_id = $1", [psychiatristId])
          }
          await client.query('DELETE FROM psychiatrist WHERE psychiatrist_id = $1', [psychiatristId])
        }
      }

      if (normalizedRole === 'admin') {
        await client.query('DELETE FROM admins WHERE signup_id = $1', [parsedSignupId])
      }

      await client.query('DELETE FROM signup WHERE signup_id = $1', [parsedSignupId])
      await client.query('COMMIT')

      return res.json({ ok: true, message: 'Profile deleted successfully.' })
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch (_) {}
      console.error('Profile delete failed:', err.message)
      return res.status(500).json({ error: 'Failed to delete profile' })
    } finally {
      client.release()
    }
  })

  // Return questionnaire snapshots assigned to mentor/psychiatrist.
  app.get('/api/questionnaire/assigned-view', async (req, res) => {
    try {
      const role = sanitizeRole(req.query.role)
      const userId = Number(req.query.userId)
      if (!role || !Number.isInteger(userId)) return res.status(400).json({ error: 'role and userId are required' })

      if (role === 'mentor') {
        const result = await dbPool.query(
          `
          SELECT
            q.student_id,
            s.username,
            q.created_at,
            q.mentalhealthsupport,
            q.concerns,
            q.religion,
            q.religion_type,
            q.spiritual_status,
            q.seek_support,
            q.expectations,
            EXISTS (
              SELECT 1
              FROM messages m
              WHERE m.student_id = q.student_id
                AND m.mentor_id = q.mentor_id
            ) AS has_contact
          FROM questionnaire q
          INNER JOIN student s ON s.student_id = q.student_id
          WHERE q.mentor_id = $1
          ORDER BY q.created_at DESC
          `,
          [userId]
        )
        return res.json({ ok: true, rows: result.rows })
      }

      if (role === 'psychiatrist') {
        const result = await dbPool.query(
          `
          SELECT
            q.student_id,
            s.username,
            q.created_at,
            q.mentalhealthsupport,
            q.concerns,
            q.religion,
            q.religion_type,
            q.spiritual_status,
            q.therapy_status,
            q.seek_support,
            q.expectations,
            EXISTS (
              SELECT 1
              FROM messages m
              WHERE m.student_id = q.student_id
                AND m.psychiatrist_id = q.psychiatrist_id
            ) AS has_contact
          FROM questionnaire q
          INNER JOIN student s ON s.student_id = q.student_id
          WHERE q.psychiatrist_id = $1
          ORDER BY q.created_at DESC
          `,
          [userId]
        )
        return res.json({ ok: true, rows: result.rows })
      }

      return res.status(400).json({ error: 'Only mentor or psychiatrist can access assigned questionnaire view' })
    } catch (err) {
      console.error('Failed to load assigned questionnaire view:', err.message)
      return res.status(500).json({ error: 'Failed to load assigned questionnaire view' })
    }
  })

  // Resolve and return a student's currently assigned support profile.
  app.get('/api/student/assigned-support', async (req, res) => {
    try {
      const studentId = Number(req.query.studentId)
      if (!Number.isInteger(studentId) || studentId <= 0) {
        return res.status(400).json({ error: 'Valid studentId is required' })
      }

      const tableExists = async (tableName) => {
        const check = await dbPool.query('SELECT to_regclass($1) AS reg', [`public.${tableName}`])
        return Boolean(check.rows[0] && check.rows[0].reg)
      }

      const questionnaireHasId = await dbPool.query(
        `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'questionnaire'
            AND column_name = 'questionnaire_id'
        ) AS exists
        `
      )

      let resolvedStudentId = studentId

      const studentTable = (await tableExists('student')) ? 'student' : (await tableExists('students')) ? 'students' : null
      if (studentTable === 'student') {
        const byStudentId = await dbPool.query('SELECT student_id FROM student WHERE student_id = $1 LIMIT 1', [studentId])
        if (!byStudentId.rows[0]) {
          const bySignup = await dbPool.query('SELECT student_id FROM student WHERE signup_id = $1 LIMIT 1', [studentId])
          if (bySignup.rows[0]) resolvedStudentId = Number(bySignup.rows[0].student_id)
        }
      } else if (studentTable === 'students') {
        const byStudentId = await dbPool.query('SELECT student_id FROM students WHERE student_id = $1 LIMIT 1', [studentId])
        if (!byStudentId.rows[0]) {
          const bySignup = await dbPool.query('SELECT student_id FROM students WHERE signup_id = $1 LIMIT 1', [studentId])
          if (bySignup.rows[0]) resolvedStudentId = Number(bySignup.rows[0].student_id)
        }
      }

      const assignment = await dbPool.query(
        `
        SELECT mentor_id, psychiatrist_id
        FROM assignments
        WHERE student_id = $1
        ORDER BY assignment_id DESC
        LIMIT 1
        `,
        [resolvedStudentId]
      )

      // Also read questionnaire assignment columns so we can resolve stale/conflicting historical data.
      const questionnaireAssignment = await dbPool.query(
        `
        SELECT mentor_id, psychiatrist_id
        FROM questionnaire
        WHERE student_id = $1
        ${questionnaireHasId.rows[0] && questionnaireHasId.rows[0].exists ? 'ORDER BY questionnaire_id DESC' : ''}
        LIMIT 1
        `,
        [resolvedStudentId]
      )

      const assignmentRow = assignment.rows[0] || {}
      const questionnaireRow = questionnaireAssignment.rows[0] || {}

      const assignmentMentorId =
        assignmentRow.mentor_id != null && Number.isFinite(Number(assignmentRow.mentor_id))
          ? Number(assignmentRow.mentor_id)
          : null
      const assignmentPsychiatristId =
        assignmentRow.psychiatrist_id != null && Number.isFinite(Number(assignmentRow.psychiatrist_id))
          ? Number(assignmentRow.psychiatrist_id)
          : null
      const questionnaireMentorId =
        questionnaireRow.mentor_id != null && Number.isFinite(Number(questionnaireRow.mentor_id))
          ? Number(questionnaireRow.mentor_id)
          : null
      const questionnairePsychiatristId =
        questionnaireRow.psychiatrist_id != null && Number.isFinite(Number(questionnaireRow.psychiatrist_id))
          ? Number(questionnaireRow.psychiatrist_id)
          : null

      const hasAssignmentMentor = assignmentMentorId != null
      const hasAssignmentPsychiatrist = assignmentPsychiatristId != null
      const hasQuestionnaireMentor = questionnaireMentorId != null
      const hasQuestionnairePsychiatrist = questionnairePsychiatristId != null

      let assignedRole = null
      let assignedId = null

      if (hasAssignmentMentor && !hasAssignmentPsychiatrist) {
        assignedRole = 'mentor'
        assignedId = assignmentMentorId
      } else if (!hasAssignmentMentor && hasAssignmentPsychiatrist) {
        assignedRole = 'psychiatrist'
        assignedId = assignmentPsychiatristId
      } else if (hasQuestionnaireMentor && !hasQuestionnairePsychiatrist) {
        // If assignments data is stale or ambiguous, prefer questionnaire's single-role signal.
        assignedRole = 'mentor'
        assignedId = questionnaireMentorId
      } else if (!hasQuestionnaireMentor && hasQuestionnairePsychiatrist) {
        assignedRole = 'psychiatrist'
        assignedId = questionnairePsychiatristId
      } else if (hasAssignmentMentor) {
        assignedRole = 'mentor'
        assignedId = assignmentMentorId
      } else if (hasAssignmentPsychiatrist) {
        assignedRole = 'psychiatrist'
        assignedId = assignmentPsychiatristId
      } else if (hasQuestionnaireMentor) {
        assignedRole = 'mentor'
        assignedId = questionnaireMentorId
      } else if (hasQuestionnairePsychiatrist) {
        assignedRole = 'psychiatrist'
        assignedId = questionnairePsychiatristId
      }

      if (!assignedRole || assignedId == null) {
        return res.json({ ok: true, assigned: false })
      }

      if (assignedRole === 'mentor') {
        const mentorTable = (await tableExists('mentor')) ? 'mentor' : (await tableExists('mentors')) ? 'mentors' : null
        if (!mentorTable) {
          return res.json({ ok: true, assigned: false })
        }

        const mentorProfile = await dbPool.query(
          `
          SELECT
            m.mentor_id,
            m.full_name,
            m.email,
            m.phone_no,
            m.bio
          FROM ${mentorTable} m
          WHERE m.mentor_id = $1
          LIMIT 1
          `,
          [assignedId]
        )

        if (!mentorProfile.rows[0]) {
          return res.json({ ok: true, assigned: false })
        }

        return res.json({
          ok: true,
          assigned: true,
          assignedRole: 'mentor',
          assignedId,
          profile: mentorProfile.rows[0] || {},
        })
      }

      const psychiatristTable = (await tableExists('psychiatrist'))
        ? 'psychiatrist'
        : (await tableExists('psychiatrists'))
          ? 'psychiatrists'
          : null
      if (!psychiatristTable) {
        return res.json({ ok: true, assigned: false })
      }

      const psychiatristProfile = await dbPool.query(
        `
        SELECT
          p.psychiatrist_id,
          p.full_name,
          p.email,
          p.phone_no,
          p.certification,
          p.licence_number,
          p.years_of_experience,
          p.billing_details
        FROM ${psychiatristTable} p
        WHERE p.psychiatrist_id = $1
        LIMIT 1
        `,
        [assignedId]
      )

      if (!psychiatristProfile.rows[0]) {
        return res.json({ ok: true, assigned: false })
      }

      return res.json({
        ok: true,
        assigned: true,
        assignedRole: 'psychiatrist',
        assignedId,
        profile: psychiatristProfile.rows[0] || {},
      })
    } catch (err) {
      console.error('Failed to load student assigned support:', err.message)
      return res.status(500).json({ error: 'Failed to load assigned support profile' })
    }
  })

  // Journal CRUD routes for students.
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

  // Chat peer discovery based on active assignments.
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

  // Admin staff account management routes.
  app.get('/api/admin/staff-accounts', async (req, res) => {
    try {
      const limit = Math.min(parsePositiveInt(req.query.limit) || 10, 50)
      const result = await dbPool.query(
        `
        SELECT
          s.signup_id,
          LOWER(COALESCE(s.role, s.role_name, '')) AS role,
          s.email,
          s.created_at,
          m.mentor_id,
          m.full_name AS mentor_full_name,
          p.psychiatrist_id,
          p.full_name AS psychiatrist_full_name
        FROM signup s
        LEFT JOIN mentor m ON m.signup_id = s.signup_id
        LEFT JOIN psychiatrist p ON p.signup_id = s.signup_id
        WHERE LOWER(COALESCE(s.role, s.role_name, '')) IN ('mentor', 'psychiatrist')
        ORDER BY s.created_at DESC
        LIMIT $1
        `,
        [limit]
      )

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          signupId: Number(row.signup_id),
          role: String(row.role || ''),
          email: String(row.email || ''),
          userId: row.role === 'mentor' ? Number(row.mentor_id || 0) || null : Number(row.psychiatrist_id || 0) || null,
          fullName: String(row.mentor_full_name || row.psychiatrist_full_name || ''),
          createdAt: toIsoString(row.created_at),
        })),
      })
    } catch (err) {
      console.error('Failed to load staff accounts:', err.message)
      return res.status(500).json({ error: 'Failed to load staff accounts.' })
    }
  })

  app.post('/api/admin/staff-accounts', async (req, res) => {
    const { role, email, password, fullName } = req.body || {}
    const normalizedRole = sanitizeRole(role)
    const safeEmail = String(email || '').trim().toLowerCase()
    const safeFullName = String(fullName || '').trim()

    if (normalizedRole !== 'mentor' && normalizedRole !== 'psychiatrist') {
      return res.status(400).json({ error: 'Role must be mentor or psychiatrist.' })
    }
    if (!safeEmail) return res.status(400).json({ error: 'Email is required.' })
    if (!safeFullName) return res.status(400).json({ error: 'Full name is required.' })
    if (!password || typeof password !== 'string') return res.status(400).json({ error: 'Password is required.' })
    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error: 'Password must be more than 6 characters and include uppercase, lowercase, and a special character.',
      })
    }

    let client = null
    try {
      const roleRow = await resolveRoleRow(dbPool, normalizedRole)
      if (!roleRow) return res.status(400).json({ error: 'Role mapping missing in roles table.' })

      const existingSignup = await dbPool.query('SELECT signup_id FROM signup WHERE LOWER(email) = LOWER($1) LIMIT 1', [safeEmail])
      if (existingSignup.rows[0]) {
        return res.status(409).json({ error: 'Email already exists. Use a different email.' })
      }

      client = await dbPool.connect()
      await client.query('BEGIN')

      const passwordHash = await bcrypt.hash(password, 10)
      const signupInsert = await client.query(
        'INSERT INTO signup (email, role_id, role_name, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING signup_id',
        [safeEmail, Number(roleRow.role_id), String(roleRow.role_name), normalizedRole, passwordHash]
      )
      const signupId = Number(signupInsert.rows[0].signup_id)

      let userId = null
      if (normalizedRole === 'mentor') {
        await ensureMentorIdAutoIncrement(client)
        await client.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)')
        const created = await client.query(
          `
          INSERT INTO mentor (signup_id, email, full_name, password_hash)
          VALUES ($1, $2, $3, $4)
          RETURNING mentor_id
          `,
          [signupId, safeEmail, safeFullName, passwordHash]
        )
        userId = Number(created.rows[0].mentor_id)
      } else {
        const psychiatristMeta = await resolvePsychiatristTableMeta(client)
        const table = psychiatristMeta ? psychiatristMeta.table : 'psychiatrist'
        const idColumn = psychiatristMeta ? psychiatristMeta.idColumn : 'psychiatrist_id'
        await ensurePsychiatristIdAutoIncrement(client)
        await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`)
        const created = await client.query(
          `
          INSERT INTO ${table} (signup_id, email, full_name, password_hash)
          VALUES ($1, $2, $3, $4)
          RETURNING ${idColumn} AS user_id
          `,
          [signupId, safeEmail, safeFullName, passwordHash]
        )
        userId = Number(created.rows[0].user_id)
      }

      await client.query('COMMIT')
      return res.json({
        ok: true,
        signupId: String(signupId),
        userId: userId == null ? null : String(userId),
        role: normalizedRole,
        message: 'Staff login account created successfully.',
      })
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK')
        } catch (_) {}
      }
      console.error('Failed to create staff account:', err.message)
      return res.status(500).json({ error: 'Failed to create staff account.' })
    } finally {
      if (client) client.release()
    }
  })

  app.put('/api/admin/staff-accounts/:signupId', async (req, res) => {
    const parsedSignupId = parsePositiveInt(req.params.signupId)
    if (!parsedSignupId) {
      return res.status(400).json({ error: 'Valid signupId is required.' })
    }

    const { email, password, fullName } = req.body || {}
    const safeEmail = String(email || '').trim().toLowerCase()
    const safeFullName = String(fullName || '').trim()
    if (!safeEmail) return res.status(400).json({ error: 'Email is required.' })

    try {
      const signupRow = await dbPool.query('SELECT signup_id, role, role_name FROM signup WHERE signup_id = $1 LIMIT 1', [parsedSignupId])
      if (!signupRow.rows[0]) return res.status(404).json({ error: 'User account not found.' })

      const normalizedRole = sanitizeRole(signupRow.rows[0].role || signupRow.rows[0].role_name)
      if (normalizedRole !== 'mentor' && normalizedRole !== 'psychiatrist') {
        return res.status(400).json({ error: 'Only mentor and psychiatrist accounts can be edited here.' })
      }

      const duplicateSignup = await dbPool.query(
        'SELECT signup_id FROM signup WHERE LOWER(email) = LOWER($1) AND signup_id <> $2 LIMIT 1',
        [safeEmail, parsedSignupId]
      )
      if (duplicateSignup.rows[0]) {
        return res.status(409).json({ error: 'Email already exists. Use a different email.' })
      }

      let passwordHash = null
      if (password != null && String(password).trim()) {
        if (!isStrongPassword(password)) {
          return res.status(400).json({
            error: 'Password must be more than 6 characters and include uppercase, lowercase, and a special character.',
          })
        }
        passwordHash = await bcrypt.hash(String(password), 10)
      }

      if (passwordHash) {
        await dbPool.query('UPDATE signup SET email = $1, password_hash = $2 WHERE signup_id = $3', [safeEmail, passwordHash, parsedSignupId])
      } else {
        await dbPool.query('UPDATE signup SET email = $1 WHERE signup_id = $2', [safeEmail, parsedSignupId])
      }

      if (normalizedRole === 'mentor') {
        if (passwordHash) {
          await dbPool.query(
            'UPDATE mentor SET email = $1, full_name = COALESCE($2, full_name), password_hash = $3 WHERE signup_id = $4',
            [safeEmail, safeFullName || null, passwordHash, parsedSignupId]
          )
        } else {
          await dbPool.query('UPDATE mentor SET email = $1, full_name = COALESCE($2, full_name) WHERE signup_id = $3', [
            safeEmail,
            safeFullName || null,
            parsedSignupId,
          ])
        }
      } else {
        const psychiatristMeta = await resolvePsychiatristTableMeta(dbPool)
        if (!psychiatristMeta) {
          return res.status(500).json({ error: 'Psychiatrist table metadata is unavailable.' })
        }

        if (passwordHash) {
          await dbPool.query(
            `UPDATE ${psychiatristMeta.table} SET email = $1, full_name = COALESCE($2, full_name), password_hash = $3 WHERE signup_id = $4`,
            [safeEmail, safeFullName || null, passwordHash, parsedSignupId]
          )
        } else {
          await dbPool.query(
            `UPDATE ${psychiatristMeta.table} SET email = $1, full_name = COALESCE($2, full_name) WHERE signup_id = $3`,
            [safeEmail, safeFullName || null, parsedSignupId]
          )
        }
      }

      return res.json({ ok: true, message: 'Staff account updated successfully.' })
    } catch (err) {
      console.error('Failed to update staff account:', err.message)
      return res.status(500).json({ error: 'Failed to update staff account.' })
    }
  })

  app.delete('/api/admin/staff-accounts/:signupId', async (req, res) => {
    const parsedSignupId = parsePositiveInt(req.params.signupId)
    if (!parsedSignupId) return res.status(400).json({ error: 'Valid signupId is required.' })

    let client = null
    try {
      const signupRow = await dbPool.query('SELECT signup_id, role, role_name FROM signup WHERE signup_id = $1 LIMIT 1', [parsedSignupId])
      if (!signupRow.rows[0]) return res.status(404).json({ error: 'User account not found.' })

      const normalizedRole = sanitizeRole(signupRow.rows[0].role || signupRow.rows[0].role_name)
      if (normalizedRole !== 'mentor' && normalizedRole !== 'psychiatrist') {
        return res.status(400).json({ error: 'Only mentor and psychiatrist accounts can be deleted here.' })
      }

      client = await dbPool.connect()
      await client.query('BEGIN')
      if (normalizedRole === 'mentor') {
        await client.query('DELETE FROM mentor WHERE signup_id = $1', [parsedSignupId])
      } else {
        const psychiatristMeta = await resolvePsychiatristTableMeta(client)
        if (!psychiatristMeta) {
          await client.query('ROLLBACK')
          return res.status(500).json({ error: 'Psychiatrist table metadata is unavailable.' })
        }
        await client.query(`DELETE FROM ${psychiatristMeta.table} WHERE signup_id = $1`, [parsedSignupId])
      }

      await client.query('DELETE FROM signup WHERE signup_id = $1', [parsedSignupId])
      await client.query('COMMIT')
      return res.json({ ok: true, message: 'Staff account deleted successfully.' })
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK')
        } catch (_) {}
      }
      console.error('Failed to delete staff account:', err.message)
      return res.status(500).json({ error: 'Failed to delete staff account.' })
    } finally {
      if (client) client.release()
    }
  })

  // Admin dashboard aggregates users, assignments, and KPI overrides.
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

  // Mentor workspace: notes, checklist, availability, and calendar.
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

  // Psychiatrist workspace: notes, risk overview, calendar, and case report.
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

  app.get('/api/psychiatrist/calendar', async (req, res) => {
    try {
      await ensureAppointmentSchema(dbPool)

      const psychiatristId = await resolvePsychiatristWorkspaceId(dbPool, req.query.psychiatristId)
      const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : new Date()
      const days = Math.min(parsePositiveInt(req.query.days) || 30, 60)

      if (!psychiatristId) {
        return res.status(404).json({ error: 'Psychiatrist profile not found. Complete psychiatrist profile setup first.' })
      }

      const startDateFloor = toUtcDateFloor(startDate)
      if (!startDateFloor) return res.status(400).json({ error: 'Invalid startDate.' })

      const endDate = new Date(startDateFloor)
      endDate.setUTCDate(endDate.getUTCDate() + days)

      await ensureGeneratedAvailabilitySlots(dbPool, {
        therapistType: 'psychiatrist',
        therapistId: psychiatristId,
        startDate: startDateFloor,
        endDate,
      })

      const availabilityRows = await dbPool.query(
        `
        SELECT availability_id, start_at, end_at, is_available
        FROM therapist_availability
        WHERE therapist_type = 'psychiatrist'
          AND therapist_id = $1
          AND start_at >= $2
          AND start_at < $3
        ORDER BY start_at ASC
        `,
        [psychiatristId, startDateFloor.toISOString(), endDate.toISOString()]
      )

      const bookedRows = await dbPool.query(
        `
        SELECT availability_id
        FROM appointments
        WHERE therapist_type = 'psychiatrist'
          AND therapist_id = $1
          AND status = 'booked'
          AND slot_start >= $2
          AND slot_start < $3
        `,
        [psychiatristId, startDateFloor.toISOString(), endDate.toISOString()]
      )

      const bookedSet = new Set(bookedRows.rows.map((row) => Number(row.availability_id)))

      const slots = availabilityRows.rows.map((row) => ({
        availabilityId: Number(row.availability_id),
        startAt: toIsoString(row.start_at),
        endAt: toIsoString(row.end_at),
        status: Boolean(row.is_available) && !bookedSet.has(Number(row.availability_id)) ? 'available' : 'booked',
      }))

      return res.json({ ok: true, psychiatristId, slots })
    } catch (err) {
      console.error('Failed to load psychiatrist calendar:', err.message)
      return res.status(500).json({ error: 'Failed to load psychiatrist calendar.' })
    }
  })

  app.get('/api/psychiatrist/case-report', async (req, res) => {
    try {
      await ensurePsychiatristWorkspaceSchema(dbPool)
      await ensureAppointmentSchema(dbPool)

      const psychiatristId = await resolvePsychiatristWorkspaceId(dbPool, req.query.psychiatristId)
      if (!psychiatristId) {
        return res.status(404).json({ error: 'Psychiatrist profile not found. Complete psychiatrist profile setup first.' })
      }

      const assignedResult = await dbPool.query(
        `
        SELECT
          a.student_id,
          s.username,
          q.concerns,
          q.therapy_status,
          q.support_type,
          q.updated_at
        FROM assignments a
        LEFT JOIN student s ON s.student_id = a.student_id
        LEFT JOIN questionnaire q ON q.student_id = a.student_id
        WHERE a.psychiatrist_id = $1
        ORDER BY a.student_id ASC
        `,
        [psychiatristId]
      )

      const upcomingAppointments = await dbPool.query(
        `
        SELECT COUNT(*)::int AS total
        FROM appointments
        WHERE therapist_type = 'psychiatrist'
          AND therapist_id = $1
          AND status = 'booked'
          AND slot_start >= NOW()
        `,
        [psychiatristId]
      )

      const noteCountResult = await dbPool.query(
        'SELECT COUNT(*)::int AS total FROM psychiatrist_notes WHERE psychiatrist_id = $1',
        [psychiatristId]
      )

      const riskCountResult = await dbPool.query(
        'SELECT COUNT(*)::int AS total FROM psychiatrist_risk_overview WHERE psychiatrist_id = $1',
        [psychiatristId]
      )

      const assignedRows = assignedResult.rows || []
      const summary = {
        totalAssignedStudents: assignedRows.length,
        upcomingAppointments: Number(upcomingAppointments.rows[0]?.total || 0),
        savedClinicalNotes: Number(noteCountResult.rows[0]?.total || 0),
        riskOverviewItems: Number(riskCountResult.rows[0]?.total || 0),
      }

      const lines = []
      lines.push('Tuliza Psychiatrist Case Report')
      lines.push(`Generated: ${new Date().toISOString()}`)
      lines.push(`Psychiatrist ID: ${psychiatristId}`)
      lines.push('')
      lines.push(`Total assigned students: ${summary.totalAssignedStudents}`)
      lines.push(`Upcoming appointments: ${summary.upcomingAppointments}`)
      lines.push(`Saved clinical notes: ${summary.savedClinicalNotes}`)
      lines.push(`Risk overview items: ${summary.riskOverviewItems}`)
      lines.push('')
      lines.push('Assigned student snapshots:')

      if (!assignedRows.length) {
        lines.push('- No currently assigned students.')
      } else {
        assignedRows.forEach((row) => {
          lines.push(
            `- Student ${row.student_id || '-'} (${row.username || 'Unknown'}): concerns=${row.concerns || 'N/A'}; therapy_status=${row.therapy_status || 'N/A'}; support_type=${row.support_type || 'N/A'}`
          )
        })
      }

      return res.json({
        ok: true,
        psychiatristId,
        summary,
        reportText: lines.join('\n'),
      })
    } catch (err) {
      console.error('Failed to generate psychiatrist case report:', err.message)
      return res.status(500).json({ error: 'Failed to generate case report.' })
    }
  })

  // Therapist day blocking/unblocking for schedule management.
  app.post('/api/therapists/block-day', async (req, res) => {
    try {
      await ensureAppointmentSchema(dbPool)

      const therapistType = normalizeTherapistType(req.body?.therapistType)
      const dateInput = String(req.body?.date || '').trim()
      if (!therapistType) return res.status(400).json({ error: 'Valid therapistType is required.' })
      if (!dateInput) return res.status(400).json({ error: 'Valid date is required.' })

      let therapistId = null
      if (therapistType === 'mentor') {
        therapistId = await resolveMentorWorkspaceId(dbPool, req.body?.therapistId)
      } else {
        therapistId = await resolvePsychiatristWorkspaceId(dbPool, req.body?.therapistId)
      }

      if (!therapistId) return res.status(404).json({ error: 'Therapist profile not found.' })

      const dayStart = new Date(dateInput)
      if (Number.isNaN(dayStart.getTime())) return res.status(400).json({ error: 'Invalid date.' })
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
        SET is_available = FALSE,
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

      return res.json({ ok: true, updatedSlots: Number(updated.rowCount || 0) })
    } catch (err) {
      console.error('Failed to block therapist day:', err.message)
      return res.status(500).json({ error: 'Failed to block day.' })
    }
  })

  app.post('/api/therapists/unblock-day', async (req, res) => {
    try {
      await ensureAppointmentSchema(dbPool)

      const therapistType = normalizeTherapistType(req.body?.therapistType)
      const dateInput = String(req.body?.date || '').trim()
      if (!therapistType) return res.status(400).json({ error: 'Valid therapistType is required.' })
      if (!dateInput) return res.status(400).json({ error: 'Valid date is required.' })

      let therapistId = null
      if (therapistType === 'mentor') {
        therapistId = await resolveMentorWorkspaceId(dbPool, req.body?.therapistId)
      } else {
        therapistId = await resolvePsychiatristWorkspaceId(dbPool, req.body?.therapistId)
      }

      if (!therapistId) return res.status(404).json({ error: 'Therapist profile not found.' })

      const dayStart = new Date(dateInput)
      if (Number.isNaN(dayStart.getTime())) return res.status(400).json({ error: 'Invalid date.' })
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
        SET is_available = TRUE,
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

      return res.json({ ok: true, updatedSlots: Number(updated.rowCount || 0) })
    } catch (err) {
      console.error('Failed to unblock therapist day:', err.message)
      return res.status(500).json({ error: 'Failed to unblock day.' })
    }
  })

  // Admin KPI override controls.
  app.put('/api/admin/kpis', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const totalStudents = parseNonNegativeInt(req.body?.totalStudents)
      const mentorsActive = parseNonNegativeInt(req.body?.mentorsActive)
      const psychiatristsActive = parseNonNegativeInt(req.body?.psychiatristsActive)
      const assignmentsActive = parseNonNegativeInt(req.body?.assignmentsActive)

      await dbPool.query(
        `
        INSERT INTO admin_kpi_overrides (
          override_id,
          total_students,
          mentors_active,
          psychiatrists_active,
          assignments_active,
          updated_at
        )
        VALUES (1, $1, $2, $3, $4, NOW())
        ON CONFLICT (override_id)
        DO UPDATE SET
          total_students = EXCLUDED.total_students,
          mentors_active = EXCLUDED.mentors_active,
          psychiatrists_active = EXCLUDED.psychiatrists_active,
          assignments_active = EXCLUDED.assignments_active,
          updated_at = NOW()
        `,
        [totalStudents, mentorsActive, psychiatristsActive, assignmentsActive]
      )

      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to update KPI overrides:', err.message)
      return res.status(500).json({ error: 'Failed to update KPI overrides.' })
    }
  })

  app.delete('/api/admin/kpis', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)
      await dbPool.query('DELETE FROM admin_kpi_overrides WHERE override_id = 1')
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to clear KPI overrides:', err.message)
      return res.status(500).json({ error: 'Failed to clear KPI overrides.' })
    }
  })

  // Complaint submission, review, and reassignment workflow.
  app.post('/api/complaints', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const studentId = parsePositiveInt(req.body?.studentId)
      const issueType = String(req.body?.issueType || 'assignment').trim().toLowerCase().slice(0, 50)
      const details = String(req.body?.details || '').trim().slice(0, 2000)
      const preferredRole = normalizeTherapistType(req.body?.preferredRole)
      const againstRole = normalizeTherapistType(req.body?.againstRole)
      const againstId = parsePositiveInt(req.body?.againstId)

      if (!studentId) return res.status(400).json({ error: 'Valid studentId is required.' })
      if (!details) return res.status(400).json({ error: 'Complaint details are required.' })

      const currentAssignment = await dbPool.query(
        'SELECT mentor_id, psychiatrist_id FROM assignments WHERE student_id = $1 LIMIT 1',
        [studentId]
      )

      const assignmentRow = currentAssignment.rows[0] || {}
      const currentAssignedRole =
        againstRole ||
        (assignmentRow.mentor_id != null ? 'mentor' : assignmentRow.psychiatrist_id != null ? 'psychiatrist' : null)

      const currentAssignedId =
        currentAssignedRole === 'mentor'
          ? assignmentRow.mentor_id == null
            ? null
            : Number(assignmentRow.mentor_id)
          : currentAssignedRole === 'psychiatrist'
            ? assignmentRow.psychiatrist_id == null
              ? null
              : Number(assignmentRow.psychiatrist_id)
            : null

      const inserted = await dbPool.query(
        `
        INSERT INTO complaints (
          student_id,
          issue_type,
          details,
          preferred_role,
          against_role,
          against_id,
          current_assigned_role,
          current_assigned_id,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', NOW(), NOW())
        RETURNING complaint_id
        `,
        [
          studentId,
          issueType,
          details,
          preferredRole,
          againstRole,
          againstId,
          currentAssignedRole,
          currentAssignedId,
        ]
      )

      return res.status(201).json({ ok: true, complaintId: Number(inserted.rows[0].complaint_id) })
    } catch (err) {
      console.error('Failed to submit complaint:', err.message)
      return res.status(500).json({ error: 'Failed to submit complaint.' })
    }
  })

  app.get('/api/admin/complaints', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const statusFilter = String(req.query.status || 'all').trim().toLowerCase()
      const includeAll = statusFilter === 'all' || !statusFilter

      const query = `
        SELECT
          c.complaint_id,
          c.student_id,
          s.username AS student_username,
          s.email AS student_email,
          c.issue_type,
          c.details,
          c.preferred_role,
          c.against_role,
          c.against_id,
          c.current_assigned_role,
          c.current_assigned_id,
          c.status,
          c.resolution_note,
          c.reassigned_role,
          c.reassigned_id,
          c.admin_signup_id,
          c.created_at,
          c.updated_at,
          c.resolved_at,
          m.full_name AS against_mentor_name,
          p.full_name AS against_psychiatrist_name
        FROM complaints c
        INNER JOIN student s ON s.student_id = c.student_id
        LEFT JOIN mentor m ON m.mentor_id = c.against_id
        LEFT JOIN psychiatrist p ON p.psychiatrist_id = c.against_id
        ${includeAll ? '' : 'WHERE LOWER(c.status) = $1'}
        ORDER BY c.created_at DESC
      `

      const result = await dbPool.query(query, includeAll ? [] : [statusFilter])

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          complaintId: Number(row.complaint_id),
          studentId: Number(row.student_id),
          studentUsername: String(row.student_username || ''),
          studentEmail: String(row.student_email || ''),
          issueType: String(row.issue_type || ''),
          details: String(row.details || ''),
          preferredRole: String(row.preferred_role || ''),
          againstRole: String(row.against_role || ''),
          againstId: row.against_id == null ? null : Number(row.against_id),
          againstName: String(row.against_mentor_name || row.against_psychiatrist_name || ''),
          currentAssignedRole: String(row.current_assigned_role || ''),
          currentAssignedId: row.current_assigned_id == null ? null : Number(row.current_assigned_id),
          status: String(row.status || 'open'),
          resolutionNote: String(row.resolution_note || ''),
          reassignedRole: String(row.reassigned_role || ''),
          reassignedId: row.reassigned_id == null ? null : Number(row.reassigned_id),
          adminSignupId: row.admin_signup_id == null ? null : Number(row.admin_signup_id),
          createdAt: toIsoString(row.created_at),
          updatedAt: toIsoString(row.updated_at),
          resolvedAt: toIsoString(row.resolved_at),
        })),
      })
    } catch (err) {
      console.error('Failed to load complaints:', err.message)
      return res.status(500).json({ error: 'Failed to load complaints.' })
    }
  })

  app.put('/api/admin/complaints/:complaintId/reassign', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const complaintId = parsePositiveInt(req.params.complaintId)
      const newRole = normalizeTherapistType(req.body?.newRole)
      const requestedAssigneeId = parsePositiveInt(req.body?.newAssigneeId)
      const adminSignupId = parsePositiveInt(req.body?.adminSignupId)
      const resolutionNote = String(req.body?.resolutionNote || '').trim().slice(0, 1000)

      if (!complaintId) return res.status(400).json({ error: 'Valid complaintId is required.' })
      if (!newRole) return res.status(400).json({ error: 'newRole must be mentor or psychiatrist.' })

      const complaintResult = await dbPool.query(
        'SELECT complaint_id, student_id, status FROM complaints WHERE complaint_id = $1 LIMIT 1',
        [complaintId]
      )
      if (!complaintResult.rows[0]) return res.status(404).json({ error: 'Complaint not found.' })

      const complaint = complaintResult.rows[0]
      const studentId = Number(complaint.student_id)

      let selectedAssigneeId = requestedAssigneeId
      if (!selectedAssigneeId) {
        selectedAssigneeId = await findLeastLoadedAssignee(dbPool, newRole)
      }
      if (!selectedAssigneeId) {
        return res.status(409).json({ error: `No available ${newRole} found for reassignment.` })
      }

      if (newRole === 'mentor') {
        const exists = await dbPool.query('SELECT mentor_id FROM mentor WHERE mentor_id = $1 LIMIT 1', [selectedAssigneeId])
        if (!exists.rows[0]) return res.status(404).json({ error: 'Selected mentor not found.' })
      }
      if (newRole === 'psychiatrist') {
        const exists = await dbPool.query('SELECT psychiatrist_id FROM psychiatrist WHERE psychiatrist_id = $1 LIMIT 1', [
          selectedAssigneeId,
        ])
        if (!exists.rows[0]) return res.status(404).json({ error: 'Selected psychiatrist not found.' })
      }

      const existingAssignment = await dbPool.query(
        'SELECT mentor_id, psychiatrist_id FROM assignments WHERE student_id = $1 LIMIT 1',
        [studentId]
      )
      const assignmentRow = existingAssignment.rows[0] || {}

      const nextMentorId = newRole === 'mentor' ? selectedAssigneeId : null

      const nextPsychiatristId = newRole === 'psychiatrist' ? selectedAssigneeId : null

      await dbPool.query(
        `
        INSERT INTO assignments (username, student_id, mentor_id, psychiatrist_id)
        VALUES (
          (SELECT username FROM student WHERE student_id = $1 LIMIT 1),
          $1,
          $2,
          $3
        )
        ON CONFLICT (student_id)
        DO UPDATE SET
          mentor_id = EXCLUDED.mentor_id,
          psychiatrist_id = EXCLUDED.psychiatrist_id
        `,
        [studentId, nextMentorId, nextPsychiatristId]
      )

      if (newRole === 'mentor') {
        await dbPool.query('UPDATE questionnaire SET mentor_id = $2, psychiatrist_id = NULL WHERE student_id = $1', [
          studentId,
          selectedAssigneeId,
        ])
      } else {
        await dbPool.query('UPDATE questionnaire SET psychiatrist_id = $2, mentor_id = NULL WHERE student_id = $1', [
          studentId,
          selectedAssigneeId,
        ])
      }

      await dbPool.query(
        `
        UPDATE complaints
        SET
          status = 'resolved',
          reassigned_role = $2,
          reassigned_id = $3,
          admin_signup_id = $4,
          resolution_note = $5,
          resolved_at = NOW(),
          updated_at = NOW()
        WHERE complaint_id = $1
        `,
        [complaintId, newRole, selectedAssigneeId, adminSignupId, resolutionNote || null]
      )

      return res.json({
        ok: true,
        complaintId,
        studentId,
        reassignedRole: newRole,
        reassignedId: selectedAssigneeId,
      })
    } catch (err) {
      console.error('Failed to reassign complaint:', err.message)
      return res.status(500).json({ error: 'Failed to process complaint reassignment.' })
    }
  })

  // Resource library CRUD (admin) and read endpoints (all users).
  app.get('/api/admin/resources', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const result = await dbPool.query(
        `
        SELECT
          r.resource_id,
          r.title,
          r.category,
          r.description,
          r.resource_content,
          r.file_link,
          r.created_at,
          r.student_id,
          s.username AS student_username
        FROM resource r
        LEFT JOIN student s ON s.student_id = r.student_id
        ORDER BY r.resource_id DESC
        `
      )

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          resourceId: Number(row.resource_id),
          title: String(row.title || ''),
          category: String(row.category || ''),
          description: String(row.description || ''),
          resourceContent: String(row.resource_content || ''),
          fileLink: String(row.file_link || ''),
          createdAt: toIsoString(row.created_at),
          studentId: row.student_id == null ? null : Number(row.student_id),
          studentUsername: String(row.student_username || ''),
        })),
      })
    } catch (err) {
      console.error('Failed to load resources:', err.message)
      return res.status(500).json({ error: 'Failed to load resources.' })
    }
  })

  app.get('/api/resources', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const result = await dbPool.query(
        `
        SELECT
          r.resource_id,
          r.title,
          r.category,
          r.description,
          r.resource_content,
          r.file_link,
          r.created_at
        FROM resource r
        ORDER BY r.created_at DESC, r.resource_id DESC
        `
      )

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          resourceId: Number(row.resource_id),
          title: String(row.title || ''),
          category: String(row.category || ''),
          description: String(row.description || ''),
          resourceContent: String(row.resource_content || ''),
          fileLink: String(row.file_link || ''),
          createdAt: toIsoString(row.created_at),
        })),
      })
    } catch (err) {
      console.error('Failed to load student resources:', err.message)
      return res.status(500).json({ error: 'Failed to load resources.' })
    }
  })

  app.post('/api/admin/resources', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const title = String(req.body?.title || '').trim().slice(0, 200)
      const category = String(req.body?.category || '').trim().slice(0, 100)
      const description = String(req.body?.description || '').trim().slice(0, 500)
      const resourceContent = String(req.body?.resourceContent || '').trim().slice(0, 20000)
      const studentId = parsePositiveInt(req.body?.studentId)

      if (!title) return res.status(400).json({ error: 'Title is required.' })

      const inserted = await dbPool.query(
        `
        INSERT INTO resource (title, category, description, resource_content, file_link, student_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING resource_id
        `,
        [title, category || null, description || null, resourceContent || null, null, studentId]
      )

      return res.status(201).json({ ok: true, resourceId: Number(inserted.rows[0].resource_id) })
    } catch (err) {
      console.error('Failed to create resource:', err.message)
      return res.status(500).json({ error: 'Failed to create resource.' })
    }
  })

  app.put('/api/admin/resources/:resourceId', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const resourceId = parsePositiveInt(req.params.resourceId)
      const title = String(req.body?.title || '').trim().slice(0, 200)
      const category = String(req.body?.category || '').trim().slice(0, 100)
      const description = String(req.body?.description || '').trim().slice(0, 500)
      const resourceContent = String(req.body?.resourceContent || '').trim().slice(0, 20000)
      const studentId = parsePositiveInt(req.body?.studentId)

      if (!resourceId) return res.status(400).json({ error: 'Valid resourceId is required.' })
      if (!title) return res.status(400).json({ error: 'Title is required.' })

      const updated = await dbPool.query(
        `
        UPDATE resource
        SET title = $1,
            category = $2,
            description = $3,
            resource_content = $4,
            file_link = NULL,
            student_id = $5
        WHERE resource_id = $6
        RETURNING resource_id
        `,
        [title, category || null, description || null, resourceContent || null, studentId, resourceId]
      )

      if (!updated.rows[0]) return res.status(404).json({ error: 'Resource not found.' })
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to update resource:', err.message)
      return res.status(500).json({ error: 'Failed to update resource.' })
    }
  })

  app.delete('/api/admin/resources/:resourceId', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)
      const resourceId = parsePositiveInt(req.params.resourceId)
      if (!resourceId) return res.status(400).json({ error: 'Valid resourceId is required.' })

      const deleted = await dbPool.query('DELETE FROM resource WHERE resource_id = $1 RETURNING resource_id', [resourceId])
      if (!deleted.rows[0]) return res.status(404).json({ error: 'Resource not found.' })

      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to delete resource:', err.message)
      return res.status(500).json({ error: 'Failed to delete resource.' })
    }
  })

  app.get('/api/resources/:resourceId', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const resourceId = parsePositiveInt(req.params.resourceId)
      if (!resourceId) return res.status(400).json({ error: 'Valid resourceId is required.' })

      const result = await dbPool.query(
        `
        SELECT
          resource_id,
          title,
          category,
          description,
          resource_content,
          file_link,
          created_at
        FROM resource
        WHERE resource_id = $1
        LIMIT 1
        `,
        [resourceId]
      )

      if (!result.rows[0]) return res.status(404).json({ error: 'Resource not found.' })

      const row = result.rows[0]
      return res.json({
        ok: true,
        resource: {
          resourceId: Number(row.resource_id),
          title: String(row.title || ''),
          category: String(row.category || ''),
          description: String(row.description || ''),
          resourceContent: String(row.resource_content || ''),
          fileLink: String(row.file_link || ''),
          createdAt: toIsoString(row.created_at),
        },
      })
    } catch (err) {
      console.error('Failed to load resource details:', err.message)
      return res.status(500).json({ error: 'Failed to load resource details.' })
    }
  })

  // Emergency contact management (admin-facing).
  app.get('/api/admin/emergency-contacts', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const result = await dbPool.query(
        `
        SELECT
          e.contact_id,
          COALESCE(e.conatct_name, e.contact_name) AS contact_name,
          e.phone_no,
          e.student_id,
          s.username AS student_username
        FROM emergency_contact e
        LEFT JOIN student s ON s.student_id = e.student_id
        ORDER BY e.contact_id DESC
        `
      )

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          contactId: Number(row.contact_id),
          contactName: String(row.contact_name || ''),
          phoneNo: row.phone_no == null ? '' : String(row.phone_no),
          studentId: row.student_id == null ? null : Number(row.student_id),
          studentUsername: String(row.student_username || ''),
        })),
      })
    } catch (err) {
      console.error('Failed to load emergency contacts:', err.message)
      return res.status(500).json({ error: 'Failed to load emergency contacts.' })
    }
  })

  app.get('/api/emergency-contacts', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const studentId = parsePositiveInt(req.query.studentId)
      const result = await dbPool.query(
        `
        SELECT
          e.contact_id,
          COALESCE(e.contact_name, e.conatct_name) AS contact_name,
          e.phone_no,
          e.student_id
        FROM emergency_contact e
        WHERE e.student_id IS NULL
           OR ($1::INT IS NOT NULL AND e.student_id = $1)
        ORDER BY e.student_id NULLS FIRST, e.contact_id ASC
        `,
        [studentId]
      )

      return res.json({
        ok: true,
        rows: result.rows.map((row) => ({
          contactId: Number(row.contact_id),
          contactName: String(row.contact_name || ''),
          phoneNo: row.phone_no == null ? '' : String(row.phone_no),
          studentId: row.student_id == null ? null : Number(row.student_id),
        })),
      })
    } catch (err) {
      console.error('Failed to load public emergency contacts:', err.message)
      return res.status(500).json({ error: 'Failed to load emergency contacts.' })
    }
  })

  app.post('/api/admin/emergency-contacts', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const contactName = String(req.body?.contactName || '').trim().slice(0, 100)
      const phoneNo = parseNullablePhone(req.body?.phoneNo)
      const studentId = parsePositiveInt(req.body?.studentId)

      if (!contactName) return res.status(400).json({ error: 'Contact name is required.' })

      const inserted = await dbPool.query(
        `
        INSERT INTO emergency_contact (conatct_name, contact_name, phone_no, student_id)
        VALUES ($1, $1, $2, $3)
        RETURNING contact_id
        `,
        [contactName, phoneNo, studentId]
      )

      return res.status(201).json({ ok: true, contactId: Number(inserted.rows[0].contact_id) })
    } catch (err) {
      console.error('Failed to create emergency contact:', err.message)
      return res.status(500).json({ error: 'Failed to create emergency contact.' })
    }
  })

  app.put('/api/admin/emergency-contacts/:contactId', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)

      const contactId = parsePositiveInt(req.params.contactId)
      const contactName = String(req.body?.contactName || '').trim().slice(0, 100)
      const phoneNo = parseNullablePhone(req.body?.phoneNo)
      const studentId = parsePositiveInt(req.body?.studentId)

      if (!contactId) return res.status(400).json({ error: 'Valid contactId is required.' })
      if (!contactName) return res.status(400).json({ error: 'Contact name is required.' })

      const updated = await dbPool.query(
        `
        UPDATE emergency_contact
        SET conatct_name = $1,
            contact_name = $1,
            phone_no = $2,
            student_id = $3
        WHERE contact_id = $4
        RETURNING contact_id
        `,
        [contactName, phoneNo, studentId, contactId]
      )

      if (!updated.rows[0]) return res.status(404).json({ error: 'Emergency contact not found.' })
      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to update emergency contact:', err.message)
      return res.status(500).json({ error: 'Failed to update emergency contact.' })
    }
  })

  app.delete('/api/admin/emergency-contacts/:contactId', async (req, res) => {
    try {
      await ensureAdminOpsSchema(dbPool)
      const contactId = parsePositiveInt(req.params.contactId)
      if (!contactId) return res.status(400).json({ error: 'Valid contactId is required.' })

      const deleted = await dbPool.query('DELETE FROM emergency_contact WHERE contact_id = $1 RETURNING contact_id', [contactId])
      if (!deleted.rows[0]) return res.status(404).json({ error: 'Emergency contact not found.' })

      return res.json({ ok: true })
    } catch (err) {
      console.error('Failed to delete emergency contact:', err.message)
      return res.status(500).json({ error: 'Failed to delete emergency contact.' })
    }
  })
}

module.exports = { setupAuthRoutes }


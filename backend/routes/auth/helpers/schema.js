const { tableExists, tableHasColumn } = require('../../../utils/schemaGuards')
const {
  normalizeTherapistType,
  toUtcDateFloor,
  toIsoString,
  isWithinWorkingHours,
  getWorkingWindowByDay,
} = require('../../../utils/appointmentTime')

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

module.exports = {
  resolvePsychiatristTableMeta,
  ensureAppointmentSchema,
  ensureJournalSchema,
  ensureAdminOpsSchema,
  ensureMentorWorkspaceSchema,
  ensurePsychiatristWorkspaceSchema,
  ensureQuestionnaireWriteSchema,
}


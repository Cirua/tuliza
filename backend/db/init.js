async function clearCoreUserRecords(dbPool) {
  await dbPool.query('DELETE FROM assignments')
  await dbPool.query('DELETE FROM questionnaire')

  // Messages reference profile IDs without ON DELETE CASCADE, so clear them first.
  await dbPool.query('DELETE FROM messages WHERE student_id IS NOT NULL OR mentor_id IS NOT NULL OR psychiatrist_id IS NOT NULL')

  await dbPool.query('DELETE FROM student')
  await dbPool.query('DELETE FROM mentor')
  await dbPool.query('DELETE FROM psychiatrist')

  await dbPool.query(`
    DELETE FROM signup
    WHERE LOWER(COALESCE(role, role_name, '')) IN ('student', 'mentor', 'psychiatrist', 'psychologist')
  `)
}

let hasClearedCoreUserRecordsInProcess = false

async function initializeDatabase(dbPool) {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      role_id SERIAL PRIMARY KEY,
      role_name VARCHAR(30) UNIQUE NOT NULL
    )
  `)

  await dbPool.query(`
    INSERT INTO roles (role_name)
    VALUES ('student'), ('mentor'), ('psychiatrist'), ('psychologist'), ('admin')
    ON CONFLICT (role_name) DO NOTHING
  `)

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS signup (
      signup_id SERIAL PRIMARY KEY,
      email VARCHAR(150) UNIQUE NOT NULL,
      role VARCHAR(30) NOT NULL,
      role_id INT,
      role_name VARCHAR(30),
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await dbPool.query('ALTER TABLE signup ADD COLUMN IF NOT EXISTS signup_id SERIAL')
  await dbPool.query('ALTER TABLE signup ADD COLUMN IF NOT EXISTS email VARCHAR(150)')
  await dbPool.query('ALTER TABLE signup ADD COLUMN IF NOT EXISTS role_id INT')
  await dbPool.query('ALTER TABLE signup ADD COLUMN IF NOT EXISTS role_name VARCHAR(30)')
  await dbPool.query('ALTER TABLE signup ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)')
  await dbPool.query('ALTER TABLE signup ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()')

  await dbPool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'signup'
          AND constraint_name = 'signup_role_id_fk'
      ) THEN
        ALTER TABLE signup
          ADD CONSTRAINT signup_role_id_fk
          FOREIGN KEY (role_id) REFERENCES roles(role_id);
      END IF;
    END $$;
  `)

  await dbPool.query(`
    UPDATE signup s
    SET role_name = COALESCE(s.role_name, r.role_name)
    FROM roles r
    WHERE s.role_id = r.role_id
      AND (s.role_name IS NULL OR s.role_name = '')
  `)

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS student (
      student_id SERIAL PRIMARY KEY,
      signup_id INT UNIQUE NOT NULL REFERENCES signup(signup_id) ON DELETE CASCADE,
      email VARCHAR(150) UNIQUE NOT NULL,
      username VARCHAR(100) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS student_id SERIAL')
  await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS signup_id INT')
  await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS email VARCHAR(150)')
  await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS username VARCHAR(100)')
  await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS full_name VARCHAR(100)')
  await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)')
  await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS student_identifier VARCHAR(50)')
  await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS gender VARCHAR(20)')
  await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS phone_no BIGINT')
  await dbPool.query('ALTER TABLE student ALTER COLUMN phone_no TYPE BIGINT USING phone_no::BIGINT')
  await dbPool.query('ALTER TABLE student ADD COLUMN IF NOT EXISTS mode_of_payment VARCHAR(50)')
  await dbPool.query('ALTER TABLE student DROP COLUMN IF EXISTS questionnaire')
  await dbPool.query(`
    DO $$
    BEGIN
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
    END $$;
  `)
  await dbPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_student_signup_unique ON student(signup_id)')

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS mentor (
      mentor_id SERIAL PRIMARY KEY,
      signup_id INT UNIQUE NOT NULL REFERENCES signup(signup_id) ON DELETE CASCADE,
      email VARCHAR(150) UNIQUE NOT NULL,
      full_name VARCHAR(120) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS mentor_id SERIAL')
  await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS signup_id INT')
  await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS email VARCHAR(150)')
  await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS full_name VARCHAR(120)')
  await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)')
  await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS phone_no BIGINT')
  await dbPool.query('ALTER TABLE mentor ALTER COLUMN phone_no TYPE BIGINT USING phone_no::BIGINT')
  await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS bio VARCHAR(100)')
  await dbPool.query('ALTER TABLE mentor ADD COLUMN IF NOT EXISTS student_id INT')
  await dbPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_mentor_signup_unique ON mentor(signup_id)')

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS psychiatrist (
      psychiatrist_id SERIAL PRIMARY KEY,
      signup_id INT UNIQUE NOT NULL REFERENCES signup(signup_id) ON DELETE CASCADE,
      email VARCHAR(150) UNIQUE NOT NULL,
      full_name VARCHAR(120) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS psychiatrist_id SERIAL')
  await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS signup_id INT')
  await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS email VARCHAR(150)')
  await dbPool.query('ALTER TABLE psychiatrist ADD COLUMN IF NOT EXISTS full_name VARCHAR(120)')
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
  await dbPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_psychiatrist_signup_unique ON psychiatrist(signup_id)')

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS questionnaire (
      questionnaire_id SERIAL PRIMARY KEY,
      mentalhealthsupport VARCHAR(10) NOT NULL,
      concerns VARCHAR(200) NOT NULL,
      period_affected VARCHAR(50) NOT NULL,
      support_type VARCHAR(50) NOT NULL,
      support_preferences VARCHAR(50) NOT NULL,
      religion TEXT NOT NULL,
      religion_type VARCHAR(50) NOT NULL,
      spiritual_status VARCHAR(50) NOT NULL,
      therapy_status VARCHAR(10) NOT NULL,
      seek_support TEXT NOT NULL,
      expectations TEXT NOT NULL,
      session_structure VARCHAR(50) NOT NULL,
      communication VARCHAR(50),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      student_id INT UNIQUE NOT NULL REFERENCES student(student_id) ON DELETE CASCADE,
      mentor_id INT REFERENCES mentor(mentor_id),
      psychiatrist_id INT REFERENCES psychiatrist(psychiatrist_id)
    )
  `)

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
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS student_id INT')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS mentor_id INT')
  await dbPool.query('ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS psychiatrist_id INT')

  await dbPool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'questionnaire' AND column_name = 'signup_id'
      ) THEN
        UPDATE questionnaire q
        SET student_id = s.student_id
        FROM student s
        WHERE q.student_id IS NULL
          AND s.signup_id = q.signup_id;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'assignments'
      ) THEN
        UPDATE questionnaire q
        SET student_id = a.student_id
        FROM assignments a
        WHERE q.student_id IS NULL
          AND a.student_id IS NOT NULL
          AND (
            (q.mentor_id IS NOT NULL AND a.mentor_id = q.mentor_id)
            OR (q.psychiatrist_id IS NOT NULL AND a.psychiatrist_id = q.psychiatrist_id)
          );
      END IF;
    END $$;
  `)

  await dbPool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM questionnaire WHERE student_id IS NULL) THEN
        ALTER TABLE questionnaire ALTER COLUMN student_id SET NOT NULL;
      END IF;
    END $$;
  `)

  await dbPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_questionnaire_student_unique ON questionnaire(student_id)
  `)

  await dbPool.query(`
    DO $$
    DECLARE
      qst_student_target TEXT;
      qst_mentor_target TEXT;
      qst_psy_target TEXT;
    BEGIN
      SELECT ccu.table_name
      INTO qst_student_target
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'questionnaire'
        AND tc.constraint_name = 'fk_qst_student'
        AND tc.constraint_type = 'FOREIGN KEY'
      LIMIT 1;

      IF qst_student_target IS DISTINCT FROM 'student' THEN
        ALTER TABLE questionnaire DROP CONSTRAINT IF EXISTS fk_qst_student;
        ALTER TABLE questionnaire
          ADD CONSTRAINT fk_qst_student
          FOREIGN KEY (student_id) REFERENCES student(student_id) ON DELETE CASCADE;
      END IF;

      SELECT ccu.table_name
      INTO qst_mentor_target
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'questionnaire'
        AND tc.constraint_name = 'fk_qst_mentor'
        AND tc.constraint_type = 'FOREIGN KEY'
      LIMIT 1;

      IF qst_mentor_target IS DISTINCT FROM 'mentor' THEN
        ALTER TABLE questionnaire DROP CONSTRAINT IF EXISTS fk_qst_mentor;
        ALTER TABLE questionnaire
          ADD CONSTRAINT fk_qst_mentor
          FOREIGN KEY (mentor_id) REFERENCES mentor(mentor_id) ON DELETE CASCADE;
      END IF;

      SELECT ccu.table_name
      INTO qst_psy_target
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'questionnaire'
        AND tc.constraint_name = 'fk_qst_psychiatrist'
        AND tc.constraint_type = 'FOREIGN KEY'
      LIMIT 1;

      IF qst_psy_target IS DISTINCT FROM 'psychiatrist' THEN
        ALTER TABLE questionnaire DROP CONSTRAINT IF EXISTS fk_qst_psychiatrist;
        ALTER TABLE questionnaire
          ADD CONSTRAINT fk_qst_psychiatrist
          FOREIGN KEY (psychiatrist_id) REFERENCES psychiatrist(psychiatrist_id) ON DELETE CASCADE;
      END IF;
    END $$;
  `)

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS assignments (
      assignment_id SERIAL PRIMARY KEY,
      username VARCHAR(100),
      student_id INT UNIQUE REFERENCES student(student_id),
      mentor_id INT REFERENCES mentor(mentor_id),
      psychiatrist_id INT REFERENCES psychiatrist(psychiatrist_id)
    )
  `)

  await dbPool.query('ALTER TABLE assignments ADD COLUMN IF NOT EXISTS assignment_id SERIAL')
  await dbPool.query('ALTER TABLE assignments ADD COLUMN IF NOT EXISTS username VARCHAR(100)')
  await dbPool.query('ALTER TABLE assignments ADD COLUMN IF NOT EXISTS student_id INT')
  await dbPool.query('ALTER TABLE assignments ADD COLUMN IF NOT EXISTS mentor_id INT')
  await dbPool.query('ALTER TABLE assignments ADD COLUMN IF NOT EXISTS psychiatrist_id INT')

  await dbPool.query('DROP INDEX IF EXISTS idx_assignments_username_unique')
  await dbPool.query('ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_username_key')
  await dbPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_student_unique ON assignments(student_id)
  `)

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      message_id SERIAL PRIMARY KEY,
      encrypted_message TEXT,
      sent_at TIMESTAMPTZ,
      student_id INT,
      mentor_id INT,
      psychiatrist_id INT,
      CONSTRAINT fk_msg_student FOREIGN KEY (student_id) REFERENCES student(student_id),
      CONSTRAINT fk_msg_mentor FOREIGN KEY (mentor_id) REFERENCES mentor(mentor_id),
      CONSTRAINT fk_msg_psychiatrist FOREIGN KEY (psychiatrist_id) REFERENCES psychiatrist(psychiatrist_id)
    )
  `)

  await dbPool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS encrypted_message TEXT')
  await dbPool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ')
  await dbPool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS student_id INT')
  await dbPool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentor_id INT')
  await dbPool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS psychiatrist_id INT')

  await dbPool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'sent_message'
      ) THEN
        UPDATE messages
        SET encrypted_message = json_build_object(
          'text', sent_message,
          'senderRole', 'student',
          'senderId', student_id
        )::text
        WHERE encrypted_message IS NULL
          AND sent_message IS NOT NULL
          AND btrim(sent_message) <> '';
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'received_message'
      ) THEN
        UPDATE messages
        SET encrypted_message = json_build_object(
          'text', received_message,
          'senderRole', CASE WHEN mentor_id IS NOT NULL THEN 'mentor' ELSE 'psychiatrist' END,
          'senderId', COALESCE(mentor_id, psychiatrist_id)
        )::text
        WHERE encrypted_message IS NULL
          AND received_message IS NOT NULL
          AND btrim(received_message) <> '';
      END IF;
    END $$;
  `)

  await dbPool.query('ALTER TABLE messages DROP COLUMN IF EXISTS sent_message')
  await dbPool.query('ALTER TABLE messages DROP COLUMN IF EXISTS received_message')

  await dbPool.query('ALTER TABLE messages DROP CONSTRAINT IF EXISTS fk_msg_student')
  await dbPool.query('ALTER TABLE messages DROP CONSTRAINT IF EXISTS fk_msg_mentor')
  await dbPool.query('ALTER TABLE messages DROP CONSTRAINT IF EXISTS fk_msg_psychiatrist')
  await dbPool.query('ALTER TABLE messages ADD CONSTRAINT fk_msg_student FOREIGN KEY (student_id) REFERENCES student(student_id)')
  await dbPool.query('ALTER TABLE messages ADD CONSTRAINT fk_msg_mentor FOREIGN KEY (mentor_id) REFERENCES mentor(mentor_id)')
  await dbPool.query(
    'ALTER TABLE messages ADD CONSTRAINT fk_msg_psychiatrist FOREIGN KEY (psychiatrist_id) REFERENCES psychiatrist(psychiatrist_id)'
  )

  await dbPool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'students_id'
      ) THEN
        UPDATE messages SET student_id = students_id WHERE student_id IS NULL AND students_id IS NOT NULL;
      END IF;
    END $$;
  `)

  await dbPool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'mentors_id'
      ) THEN
        UPDATE messages SET mentor_id = mentors_id WHERE mentor_id IS NULL AND mentors_id IS NOT NULL;
      END IF;
    END $$;
  `)

  await dbPool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'psychiatrists_id'
      ) THEN
        UPDATE messages SET psychiatrist_id = psychiatrists_id WHERE psychiatrist_id IS NULL AND psychiatrists_id IS NOT NULL;
      END IF;
    END $$;
  `)

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_signup_email_role_id ON signup(email, role_id)
  `)

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_student_mentor ON messages(student_id, mentor_id)
  `)

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_student_psychiatrist ON messages(student_id, psychiatrist_id)
  `)

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

  const shouldClearCoreUserRecords = String(process.env.CLEAR_CORE_USER_RECORDS || '').trim().toLowerCase() === 'true'
  if (shouldClearCoreUserRecords && !hasClearedCoreUserRecordsInProcess) {
    console.warn('[DANGER] CLEAR_CORE_USER_RECORDS=true detected. Running one-time core user data cleanup for this process.')
    await clearCoreUserRecords(dbPool)
    hasClearedCoreUserRecordsInProcess = true
  }
}

module.exports = { initializeDatabase }

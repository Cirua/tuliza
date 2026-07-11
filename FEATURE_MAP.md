# Tuliza Backend Feature Map

This file is a quick map of major backend functionality and where it is implemented.

## Main Route Assembly

- Route assembler and temporary legacy bridge:
  - `backend/routes/auth.js`
- Modular auth route index:
  - `backend/routes/auth/routes/index.js`

## Authentication and Account Flows

- Signup and login endpoints:
  - `backend/routes/auth/routes/auth.js`
- Session token utilities:
  - `backend/auth/sessionToken.js`
- Staff account helper logic:
  - `backend/routes/auth/helpers/staffAccounts.js`

## Profile and Questionnaire

- Profile endpoints (get/save/delete profile):
  - `backend/routes/profile.js`
- Questionnaire submission, assignment logic, and assigned view:
  - `backend/routes/questionnaire.js`

## Appointments and Availability

- Booking and availability endpoints:
  - `backend/routes/auth/routes/appointments.js`
- Mentor availability and calendar endpoints:
  - `backend/routes/auth/routes/mentorAvailability.js`
- Psychiatrist calendar and case report endpoints:
  - `backend/routes/auth/routes/psychiatristAvailabilityReport.js`
- Admin block/unblock therapist day helper:
  - `backend/routes/auth/helpers/therapistAvailabilityAdmin.js`
- Shared appointment time helpers:
  - `backend/utils/appointmentTime.js`

## Mentor Workspace

- Mentor notes and checklist endpoints:
  - `backend/routes/auth/routes/mentorWorkspace.js`

## Psychiatrist Workspace

- Psychiatrist notes and risk overview endpoints:
  - `backend/routes/auth/routes/psychiatristWorkspace.js`

## Admin Operations

- Admin KPIs, complaints, resources, and emergency contacts:
  - `backend/routes/adminOps.js`

## Chat and Realtime

- Chat REST handlers:
  - `backend/chat.js`
- WebSocket handlers:
  - `backend/sockets/websocket.js`
  - `backend/sockets/users.js`

## Database and Initialization

- DB initialization and schema guards/migrations:
  - `backend/db/init.js`
- DB pool:
  - `backend/db/pool.js`
- Connection setup:
  - `backend/connect.js`

## Shared Utilities

- Role/path helpers:
  - `backend/utils/roleHelpers.js`
- Schema existence checks:
  - `backend/utils/schemaGuards.js`
- Input parsing/validation helpers:
  - `backend/utils/inputParsers.js`
- App config mapping:
  - `backend/config.js`

## Current Refactor Status

- Extracted route groups now live under `backend/routes/auth/routes/*`.
- `backend/routes/auth.js` is acting as both:
  - modular route orchestrator, and
  - temporary host for remaining legacy endpoints not yet extracted.

When the extraction is complete, `backend/routes/auth.js` can be reduced to a thin orchestrator only.

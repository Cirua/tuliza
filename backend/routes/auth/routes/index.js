const { setupAppointmentsRoutes } = require('./appointments')
const { setupAuthRoutes: setupLoginSignupRoutes } = require('./auth')
const { setupMentorWorkspaceRoutes } = require('./mentorWorkspace')
const { setupMentorAvailabilityRoutes } = require('./mentorAvailability')
const { setupPsychiatristWorkspaceRoutes } = require('./psychiatristWorkspace')
const { setupPsychiatristAvailabilityReportRoutes } = require('./psychiatristAvailabilityReport')

function setupAuthRoutesFromModules(app, dbPool, deps) {
  setupLoginSignupRoutes(app, dbPool, deps)
  setupAppointmentsRoutes(app, dbPool, deps)
  setupMentorWorkspaceRoutes(app, dbPool, deps)
  setupMentorAvailabilityRoutes(app, dbPool, deps)
  setupPsychiatristWorkspaceRoutes(app, dbPool, deps)
  setupPsychiatristAvailabilityReportRoutes(app, dbPool, deps)
}

module.exports = { setupAuthRoutesFromModules }


(function () {
  const pageName = window.location.pathname.split('/').pop() || '';
  const excludedPages = new Set(['admin.html', 'mentor.html', 'psychologist.html']);
  if (excludedPages.has(pageName)) return;

  const widgetHtml = `
    <button id="bookAppointmentFab" class="appointment-fab" type="button" aria-label="Book appointment">
      <span class="appointment-fab-icon" aria-hidden="true">+</span>
      <span>Book Appointment</span>
    </button>

    <div id="appointmentModal" class="modal-overlay appointment-overlay" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="appointmentModalTitle">
      <div class="modal appointment-modal">
        <div class="modal-header">
          <p class="modal-eyebrow">Appointments</p>
          <h2 id="appointmentModalTitle" class="modal-title">Book with your therapist</h2>
          <p class="modal-subtitle">Choose an available slot. Unavailable slots are disabled.</p>
        </div>

        <div class="appointment-controls">
          <div class="form-group">
            <label class="form-label" for="therapistType">Therapist role</label>
            <select id="therapistType" class="form-select">
              <option value="mentor">Mentor</option>
              <option value="psychiatrist">Psychologist</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="therapistId">Assigned therapist</label>
            <select id="therapistId" class="form-select"></select>
          </div>
          <div class="form-group">
            <label class="form-label" for="appointmentDate">Pick date (optional)</label>
            <input id="appointmentDate" class="form-input" type="date" />
          </div>
          <div class="form-group">
            <label class="form-label" for="appointmentTime">Preferred time</label>
            <input id="appointmentTime" class="form-input" type="time" step="900" />
          </div>
          <div class="form-group">
            <label class="form-label" for="appointmentSlotSelect">Available slots</label>
            <select id="appointmentSlotSelect" class="form-select" disabled>
              <option value="">Choose date and therapist to see slots</option>
            </select>
          </div>
        </div>

        <div class="appointment-legend" aria-label="Slot meaning">
          <span class="appointment-legend-item"><span class="slot-dot slot-dot-available"></span>Available</span>
          <span class="appointment-legend-item"><span class="slot-dot slot-dot-taken"></span>Taken</span>
        </div>

        <p id="appointmentFeedback" class="appointment-feedback" aria-live="polite"></p>

        <div class="modal-actions">
          <button id="confirmAppointmentBtn" class="btn-primary" type="button" disabled>Book Appointment</button>
          <button id="closeAppointmentModal" class="btn-ghost-modal" type="button">Close</button>
        </div>
      </div>
    </div>

    <div id="appointmentSuccessModal" class="modal-overlay" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="appointmentSuccessTitle">
      <div class="modal" style="max-width:460px; border-top:5px solid var(--success);">
        <div class="modal-header">
          <p class="modal-eyebrow" style="color:var(--success);">Appointment booked</p>
          <h2 id="appointmentSuccessTitle" class="modal-title">Booking confirmed</h2>
          <p id="appointmentSuccessBody" class="modal-subtitle">Your appointment has been saved successfully.</p>
        </div>
        <div class="modal-actions">
          <button id="appointmentSuccessClose" class="btn-ghost-modal" type="button">Close</button>
          <a id="appointmentSuccessGoogle" class="btn-primary" href="https://calendar.google.com/calendar/u/0/r" target="_self" rel="noopener noreferrer">Add to Google Calendar</a>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', widgetHtml);

  const bookAppointmentFab = document.getElementById('bookAppointmentFab');
  const appointmentModal = document.getElementById('appointmentModal');
  const closeAppointmentModal = document.getElementById('closeAppointmentModal');
  const therapistTypeInput = document.getElementById('therapistType');
  const therapistIdInput = document.getElementById('therapistId');
  const appointmentDateInput = document.getElementById('appointmentDate');
  const appointmentTimeInput = document.getElementById('appointmentTime');
  const appointmentSlotSelect = document.getElementById('appointmentSlotSelect');
  const appointmentFeedback = document.getElementById('appointmentFeedback');
  const confirmAppointmentBtn = document.getElementById('confirmAppointmentBtn');
  const appointmentSuccessModal = document.getElementById('appointmentSuccessModal');
  const appointmentSuccessBody = document.getElementById('appointmentSuccessBody');
  const appointmentSuccessClose = document.getElementById('appointmentSuccessClose');
  const appointmentSuccessGoogle = document.getElementById('appointmentSuccessGoogle');
  let resolvedStudentId = null;
  let availabilityRequestId = 0;
  let preferredTherapistType = null;
  let preferredTherapistId = null;
  let selectedAvailabilityId = null;
  let selectedSlotLabel = '';

  function todayYmd() {
    return new Date().toISOString().slice(0, 10);
  }

  function currentHm() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  function hhmmToMinutes(value) {
    if (!value || !value.includes(':')) return null;
    const [hours, minutes] = value.split(':').map((part) => Number(part));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    return (hours * 60) + minutes;
  }

  function minutesToHm(minutes) {
    const safe = Math.max(0, Math.min(24 * 60, minutes));
    const hours = String(Math.floor(safe / 60)).padStart(2, '0');
    const mins = String(safe % 60).padStart(2, '0');
    return `${hours}:${mins}`;
  }

  function addDays(ymd, days) {
    const date = new Date(`${ymd}T00:00:00`);
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function getWorkingWindowByDate(ymd) {
    if (!ymd) return null;
    const date = new Date(`${ymd}T00:00:00`);
    const day = date.getDay();

    if (day === 0) return null; // Sunday closed
    if (day === 6) {
      return { min: '10:00', max: '14:00', label: 'Saturday 10:00-14:00' };
    }
    return { min: '09:00', max: '17:00', label: 'Monday-Friday 09:00-17:00' };
  }

  function ensureDateWithinWorkingDays() {
    if (!appointmentDateInput.value) return false;

    let date = appointmentDateInput.value;
    let window = getWorkingWindowByDate(date);
    if (window) return false;

    // If Sunday is selected, move to Monday.
    date = addDays(date, 1);
    appointmentDateInput.value = date;
    appointmentFeedback.textContent = 'Sunday is unavailable. Shifted to the next available day.';
    return true;
  }

  function applyWorkingWindowToTimeInput() {
    const selectedDate = appointmentDateInput.value;
    const window = getWorkingWindowByDate(selectedDate);
    if (!window) {
      appointmentTimeInput.min = '';
      appointmentTimeInput.max = '';
      return null;
    }

    appointmentTimeInput.min = window.min;
    appointmentTimeInput.max = window.max;

    const selectedMinutes = hhmmToMinutes(appointmentTimeInput.value);
    const minMinutes = hhmmToMinutes(window.min);
    const maxMinutes = hhmmToMinutes(window.max);

    if (selectedMinutes == null || selectedMinutes < minMinutes) {
      appointmentTimeInput.value = window.min;
    }
    if (selectedMinutes != null && selectedMinutes > maxMinutes) {
      appointmentTimeInput.value = window.max;
    }

    return window;
  }

  function toGoogleLocalDateTime(dateInput) {
    const date = new Date(dateInput);
    if (Number.isNaN(date.getTime())) return '';

    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}T${hours}${minutes}${seconds}`;
  }

  function buildGoogleCalendarUrl({ startAt, endAt, therapistType, therapistId }) {
    const text = 'Tuliza Therapy Appointment';
    const details = `Therapist type: ${therapistType}, Therapist ID: ${therapistId}`;
    const dates = `${toGoogleLocalDateTime(startAt)}/${toGoogleLocalDateTime(endAt)}`;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Nairobi';
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text,
      details,
      dates,
      ctz: timeZone,
    });
    return `https://calendar.google.com/calendar/u/0/r/eventedit?${params.toString()}`;
  }

  function closeSuccessModal() {
    appointmentSuccessModal.style.display = 'none';
  }

  function openSuccessModal({ googleUrl, slotStart }) {
    const formattedStart = new Date(slotStart).toLocaleString();
    appointmentSuccessBody.textContent = `Booked successfully. Slot starts at ${formattedStart}.`;
    appointmentSuccessGoogle.href = googleUrl;
    appointmentSuccessModal.style.display = 'flex';
  }

  function updateConfirmButtonState() {
    if (!confirmAppointmentBtn) return;
    confirmAppointmentBtn.disabled = !selectedAvailabilityId;
  }

  function clearSelectedSlot() {
    selectedAvailabilityId = null;
    selectedSlotLabel = '';
    if (appointmentSlotSelect) {
      appointmentSlotSelect.value = '';
    }
    updateConfirmButtonState();
  }

  async function parseJsonResponse(response, fallbackMessage) {
    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (_) {
        const trimmed = text.trim().toLowerCase();
        if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
          throw new Error('API returned HTML instead of JSON. Start backend and open pages via http://localhost:3000, not Live Server.');
        }
        throw new Error('Server returned a non-JSON response. Please restart backend and try again.');
      }
    }

    if (!response.ok) {
      throw new Error((payload && payload.error) || fallbackMessage);
    }

    return payload || {};
  }

  function getSessionUser() {
    try {
      const raw = sessionStorage.getItem('tuliza_session_user') || localStorage.getItem('tuliza_session_user');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function getStudentIdentityCandidate() {
    const session = getSessionUser();
    if (session && session.role === 'student') {
      if (session.userId) return String(session.userId);
      if (session.signupId) return String(session.signupId);
      if (session.alias) return String(session.alias);
      if (session.email) return String(session.email);
    }

    try {
      const signupRaw = localStorage.getItem('tuliza_signup_user');
      if (!signupRaw) return null;
      const signup = JSON.parse(signupRaw);
      if (signup && signup.role === 'student') {
        if (signup.userId) return String(signup.userId);
        if (signup.signupId) return String(signup.signupId);
        if (signup.alias) return String(signup.alias);
        if (signup.email) return String(signup.email);
      }
    } catch (_) {
      return null;
    }

    return null;
  }

  async function resolveStudentIdFromSession() {
    preferredTherapistType = null;
    preferredTherapistId = null;

    const identifier = getStudentIdentityCandidate();
    if (!identifier) {
      resolvedStudentId = null;
      appointmentFeedback.textContent = 'Login as a student on the Account page to book appointments.';
      return;
    }

    const response = await fetch(`/api/users/resolve-id?role=student&identifier=${encodeURIComponent(identifier)}`);
    const payload = await parseJsonResponse(response, 'Could not resolve your student account.');
    if (!payload.userId) {
      throw new Error('Could not resolve your student account.');
    }

    resolvedStudentId = Number(payload.userId);

    try {
      const assignmentResponse = await fetch(`/api/student/assigned-support?studentId=${encodeURIComponent(String(resolvedStudentId))}`);
      const assignmentPayload = await parseJsonResponse(assignmentResponse, 'Could not load assigned therapist.');
      if (assignmentPayload.assigned && assignmentPayload.assignedRole && assignmentPayload.assignedId) {
        preferredTherapistType = String(assignmentPayload.assignedRole);
        preferredTherapistId = Number(assignmentPayload.assignedId);
      }
    } catch (_) {
      preferredTherapistType = null;
      preferredTherapistId = null;
    }
  }

  async function loadTherapists() {
    if (preferredTherapistType) {
      therapistTypeInput.value = preferredTherapistType;
    }

    const therapistType = therapistTypeInput.value;
    therapistIdInput.innerHTML = '';

    const response = await fetch(`/api/therapists?type=${encodeURIComponent(therapistType)}`);
    const payload = await parseJsonResponse(response, 'Could not load therapists.');

    const optionsHtml = (payload.therapists || [])
      .map((therapist) => `<option value="${therapist.therapistId}">${therapist.displayName} (#${therapist.therapistId})</option>`)
      .join('');

    therapistIdInput.innerHTML = optionsHtml;
    if (preferredTherapistId && String(preferredTherapistType || '') === String(therapistType)) {
      const preferredOption = therapistIdInput.querySelector(`option[value="${preferredTherapistId}"]`);
      if (preferredOption) {
        therapistIdInput.value = String(preferredTherapistId);
      }
    }

    if (!optionsHtml) {
      appointmentFeedback.textContent = 'No therapists found for this role yet.';
    }
  }

  function closeModal() {
    appointmentModal.style.display = 'none';
    clearSelectedSlot();
  }

  function renderSlotDropdown(slots) {
    const selectedTime = appointmentTimeInput.value;
    const selectedMinutes = hhmmToMinutes(selectedTime);
    const window = getWorkingWindowByDate(appointmentDateInput.value);
    const windowStart = window ? hhmmToMinutes(window.min) : null;
    const windowEnd = window ? hhmmToMinutes(window.max) : null;
    const now = new Date();

    const filteredSlots = slots
      .filter((slot) => {
        if (slot.status !== 'available') return false;
        const start = new Date(slot.startAt);
        const end = new Date(slot.endAt);
        const startMinutes = (start.getHours() * 60) + start.getMinutes();
        const endMinutes = (end.getHours() * 60) + end.getMinutes();
        const inWorkingWindow = windowStart == null || windowEnd == null
          ? true
          : (startMinutes >= windowStart && endMinutes <= windowEnd);
        const isUpcoming = end > now;
        return inWorkingWindow && isUpcoming;
      })
      .sort((a, b) => {
        const aDate = new Date(a.startAt);
        const bDate = new Date(b.startAt);
        if (selectedMinutes == null) return aDate - bDate;
        const aDelta = Math.abs(((aDate.getHours() * 60) + aDate.getMinutes()) - selectedMinutes);
        const bDelta = Math.abs(((bDate.getHours() * 60) + bDate.getMinutes()) - selectedMinutes);
        if (aDelta !== bDelta) return aDelta - bDelta;
        return aDate - bDate;
      });

    if (!filteredSlots.length) {
      appointmentSlotSelect.innerHTML = '<option value="">No available slots for this selection</option>';
      appointmentSlotSelect.disabled = true;
      clearSelectedSlot();
      return { available: 0, taken: 0, timeFilter: selectedTime };
    }

    const options = ['<option value="">Select an available slot</option>'];
    filteredSlots.forEach((slot) => {
      const startDate = new Date(slot.startAt);
      const endDate = new Date(slot.endAt);
      const label = `${startDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      options.push(`<option value="${slot.availabilityId}" data-slot-start-at="${slot.startAt}">${label}</option>`);
    });

    appointmentSlotSelect.innerHTML = options.join('');
    appointmentSlotSelect.disabled = false;
    clearSelectedSlot();
    return { available: filteredSlots.length, taken: 0, timeFilter: selectedTime };
  }

  async function loadAvailability() {
    const requestId = ++availabilityRequestId;
    const therapistType = therapistTypeInput.value;
    const therapistId = Number(therapistIdInput.value);
    if (!therapistType || !therapistId) {
      appointmentFeedback.textContent = 'Please choose a therapist.';
      appointmentSlotSelect.innerHTML = '<option value="">Choose a therapist first</option>';
      appointmentSlotSelect.disabled = true;
      return;
    }

    const minimumDate = todayYmd();
    if (appointmentDateInput.value && appointmentDateInput.value < minimumDate) {
      appointmentDateInput.value = minimumDate;
      appointmentFeedback.textContent = 'Past dates are not allowed. Showing today onward.';
    }

    if (ensureDateWithinWorkingDays()) {
      // Date changed from Sunday to Monday, continue with updated value.
    }

    const window = applyWorkingWindowToTimeInput();

    if (appointmentDateInput.value === minimumDate && appointmentTimeInput.value && appointmentTimeInput.value < currentHm()) {
      appointmentTimeInput.value = currentHm();
      appointmentFeedback.textContent = 'Past times are not allowed for today. Showing upcoming time slots.';
    }

    const correctedCurrentTime = hhmmToMinutes(currentHm());
    if (appointmentDateInput.value === minimumDate && window) {
      const minMinutes = hhmmToMinutes(window.min);
      const maxMinutes = hhmmToMinutes(window.max);
      if (correctedCurrentTime > maxMinutes) {
        appointmentSlotSelect.innerHTML = '<option value="">Booking window closed for today</option>';
        appointmentSlotSelect.disabled = true;
        clearSelectedSlot();
        appointmentFeedback.textContent = `Booking hours are over for today (${window.label}). Please choose another date.`;
        return;
      }

      if (correctedCurrentTime > minMinutes && hhmmToMinutes(appointmentTimeInput.value) < correctedCurrentTime) {
        appointmentTimeInput.value = minutesToHm(correctedCurrentTime);
      }
    }

    appointmentFeedback.textContent = 'Loading therapist availability...';
    appointmentSlotSelect.innerHTML = '<option value="">Loading available slots...</option>';
    appointmentSlotSelect.disabled = true;
    clearSelectedSlot();

    try {
      const selectedDate = appointmentDateInput.value;
      const datePart = selectedDate ? `&startDate=${encodeURIComponent(selectedDate)}&days=1` : '&days=14';
      const response = await fetch(`/api/appointments/availability?therapistType=${encodeURIComponent(therapistType)}&therapistId=${encodeURIComponent(String(therapistId))}${datePart}`);
      const data = await parseJsonResponse(response, 'Could not load availability.');
      if (requestId !== availabilityRequestId) return;
      const summary = renderSlotDropdown(data.slots || []);
      if (summary.available > 0) {
        appointmentFeedback.textContent = `${summary.available} slot(s) available. Choose one from the dropdown and click Book Appointment.`;
      } else {
        appointmentFeedback.textContent = 'No available slots for this date. Try another date or therapist.';
      }
    } catch (err) {
      if (requestId !== availabilityRequestId) return;
      appointmentSlotSelect.innerHTML = '<option value="">Could not load slots</option>';
      appointmentSlotSelect.disabled = true;
      appointmentFeedback.textContent = err.message || 'Failed to load availability.';
    }
  }

  async function bookSlot() {
    const therapistType = therapistTypeInput.value;
    const therapistId = Number(therapistIdInput.value);
    const studentId = Number(resolvedStudentId);
    const availabilityId = Number(selectedAvailabilityId);

    if (!therapistType || !therapistId || !studentId || !availabilityId) {
      appointmentFeedback.textContent = 'Choose an available time slot first, then click Book Appointment.';
      return;
    }

    appointmentFeedback.textContent = 'Booking slot...';
    updateConfirmButtonState();

    try {
      const response = await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId,
          therapistType,
          therapistId,
          availabilityId,
        }),
      });

      const result = await parseJsonResponse(response, 'Booking failed.');

      await loadAvailability();
      appointmentFeedback.textContent = `Booked successfully. Slot starts at ${new Date(result.slotStart).toLocaleString()}.`;
      const googleUrl = buildGoogleCalendarUrl({
        startAt: result.slotStart,
        endAt: result.slotEnd,
        therapistType,
        therapistId,
      });
      openSuccessModal({ googleUrl, slotStart: result.slotStart });
    } catch (err) {
      const message = String(err.message || 'Could not complete booking.');
      if (message.toLowerCase().includes('already been booked') || message.toLowerCase().includes('no longer available')) {
        appointmentFeedback.textContent = 'This time has already been booked by another user. Please choose another time.';
        await loadAvailability();
      } else {
        appointmentFeedback.textContent = message;
      }
    }
  }

  function openAppointmentModal() {
    appointmentModal.style.display = 'flex';
    (async () => {
      appointmentFeedback.textContent = 'Preparing booking options...';
      try {
        appointmentDateInput.value = '';
        if (!appointmentTimeInput.value) {
          const nowMinutes = hhmmToMinutes(currentHm()) || 0;
          const rounded = Math.ceil(nowMinutes / 15) * 15;
          appointmentTimeInput.value = minutesToHm(rounded);
        }
        appointmentDateInput.min = todayYmd();
        ensureDateWithinWorkingDays();
        applyWorkingWindowToTimeInput();
        await resolveStudentIdFromSession();
        await loadTherapists();
        await loadAvailability();
      } catch (err) {
        appointmentFeedback.textContent = err.message || 'Could not prepare booking options.';
      }
    })();
  }

  bookAppointmentFab.addEventListener('click', openAppointmentModal);
  closeAppointmentModal.addEventListener('click', closeModal);
  appointmentModal.addEventListener('click', (event) => {
    if (event.target === appointmentModal) closeModal();
  });
  appointmentSuccessModal.addEventListener('click', (event) => {
    if (event.target === appointmentSuccessModal) closeSuccessModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && appointmentModal.style.display === 'flex') {
      closeModal();
    }
    if (event.key === 'Escape' && appointmentSuccessModal.style.display === 'flex') {
      closeSuccessModal();
    }
  });
  appointmentSuccessClose.addEventListener('click', closeSuccessModal);

  therapistTypeInput.addEventListener('change', async () => {
    try {
      await loadTherapists();
      await loadAvailability();
    } catch (err) {
      appointmentFeedback.textContent = err.message || 'Could not load therapist options.';
    }
  });
  therapistIdInput.addEventListener('change', loadAvailability);
  appointmentDateInput.addEventListener('change', loadAvailability);
  appointmentTimeInput.addEventListener('change', loadAvailability);
  appointmentSlotSelect.addEventListener('change', () => {
    const selectedValue = Number(appointmentSlotSelect.value);
    if (!selectedValue) {
      clearSelectedSlot();
      appointmentFeedback.textContent = 'Choose an available slot to continue.';
      return;
    }

    const selectedOption = appointmentSlotSelect.options[appointmentSlotSelect.selectedIndex];
    const slotStartAt = String(selectedOption?.getAttribute('data-slot-start-at') || '').trim();
    const slotStartDate = slotStartAt ? new Date(slotStartAt) : null;
    if (slotStartDate && !Number.isNaN(slotStartDate.getTime())) {
      appointmentTimeInput.value = `${String(slotStartDate.getHours()).padStart(2, '0')}:${String(slotStartDate.getMinutes()).padStart(2, '0')}`;
    }

    selectedAvailabilityId = selectedValue;
    selectedSlotLabel = String(selectedOption?.textContent || '').trim();
    updateConfirmButtonState();
  });
  confirmAppointmentBtn.addEventListener('click', bookSlot);
})();

// Tuliza chat (student ↔ mentor ↔ psychiatrist) using WebSocket
// Server: ws://localhost:3000/server

(function () {
  const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/server`;
  const params = new URLSearchParams(window.location.search);

  const studentPanel = document.getElementById('chat-student-panel');
  const staffPanel = document.getElementById('chat-staff-panel');
  if (!studentPanel && !staffPanel) return;

  const nameInput = document.getElementById('chat-username');
  const joinModal = document.getElementById('chat-join-modal');
  const joinForm = document.getElementById('chat-join-form');

  function isStaffRole(role) {
    return role === 'mentor' || role === 'psychiatrist';
  }

  let sessionUser = null;
  try {
    sessionUser = JSON.parse(sessionStorage.getItem('tuliza_session_user') || '{}');
  } catch (_) {
    sessionUser = null;
  }

  const roleHintFromSession = sessionUser?.role || params.get('role') || null;
  const useStaffPanel = isStaffRole(roleHintFromSession) && Boolean(staffPanel);

  if (studentPanel) studentPanel.hidden = useStaffPanel;
  if (staffPanel) staffPanel.hidden = !useStaffPanel;

  const activePanel = useStaffPanel ? staffPanel : studentPanel;
  const header = activePanel?.querySelector('[data-chat-header]');
  const messagesEl = activePanel?.querySelector('[data-chat-messages]');
  const inputForm = activePanel?.querySelector('[data-chat-input-form]');
  const input = activePanel?.querySelector('[data-chat-input]');
  const clearBtn = activePanel?.querySelector('[data-chat-clear]');
  const threadPanel = activePanel?.querySelector('[data-chat-thread-panel]') || null;
  const threadList = activePanel?.querySelector('[data-chat-thread-list]') || null;
  const threadHelp = activePanel?.querySelector('[data-chat-thread-help]') || null;

  if (!header || !messagesEl || !inputForm || !input || !clearBtn || !nameInput || !joinModal || !joinForm) return;

  // State
  let ws;
  let myRole = null;
  let myUserId = null;
  let myDisplayName = null;
  let activePeerUserId = null;
  let activePeerRole = null;
  let loadedThreadList = false;
  let pendingJoinPayload = null;
  let seenMessageIds = new Set();
  const unreadByStudent = new Map();
  let assignedThreads = [];

  // Helpers
  function roleLabel(role) {
    if (role === 'student') return 'Student';
    if (role === 'mentor') return 'Mentor';
    if (role === 'psychiatrist') return 'Psychiatrist';
    return role || '';
  }

  function isMentorOrPsychiatrist() {
    return myRole === 'mentor' || myRole === 'psychiatrist';
  }

  function peerSubtitle(peerName, peerRole) {
    if (!peerName) return 'Unassigned';
    const peerRoleText = peerRole ? roleLabel(peerRole) : '';
    return `${peerName}${peerRoleText ? ` (${peerRoleText})` : ''}`;
  }

  function setHeaderText(statusText) {
    if (!header) return;
    header.textContent = statusText;
  }

  function clearChatWindow() {
    messagesEl.innerHTML = '';
    seenMessageIds = new Set();
  }

  function normalizeStudentIdFromMessage(message) {
    const fromRole = String(message?.fromRole || '');
    const toRole = String(message?.toRole || '');
    const sender = message?.sender != null ? String(message.sender) : '';
    const toUserId = message?.toUserId != null ? String(message.toUserId) : '';
    const threadStudentId = message?.threadStudentId != null ? String(message.threadStudentId) : '';

    if (threadStudentId) return threadStudentId;
    if (fromRole === 'student') return sender;
    if (toRole === 'student' && sender === String(myUserId) && toUserId) return toUserId;
    return '';
  }

  function messageBelongsToActiveThread(message) {
    if (!isMentorOrPsychiatrist()) return true;
    if (!activePeerUserId) return false;

    const studentId = normalizeStudentIdFromMessage(message);
    return studentId === String(activePeerUserId);
  }

  function updateThreadHelpText() {
    if (!threadHelp) return;
    if (!assignedThreads.length) {
      threadHelp.textContent = 'No assigned students yet.';
      return;
    }
    threadHelp.textContent = 'Choose a student to open their chat box.';
  }

  function renderThreadList() {
    if (!threadList) return;

    threadList.innerHTML = '';
    updateThreadHelpText();

    if (!assignedThreads.length) {
      const empty = document.createElement('p');
      empty.className = 'chat-thread-empty';
      empty.textContent = 'No active student conversations.';
      threadList.appendChild(empty);
      return;
    }

    assignedThreads.forEach((thread) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-thread-item';
      button.dataset.studentId = String(thread.studentId);
      if (String(thread.studentId) === String(activePeerUserId)) {
        button.classList.add('active');
      }

      const name = document.createElement('span');
      name.className = 'chat-thread-name';
      name.textContent = thread.username;

      const meta = document.createElement('span');
      meta.className = 'chat-thread-meta';
      meta.textContent = `Student ID: ${thread.studentId}`;

      const unreadCount = unreadByStudent.get(String(thread.studentId)) || 0;
      if (unreadCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'chat-thread-badge';
        badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        button.appendChild(badge);
      }

      button.appendChild(name);
      button.appendChild(meta);

      button.addEventListener('click', () => {
        switchThread(String(thread.studentId), 'student', thread.username);
      });

      threadList.appendChild(button);
    });
  }

  function incrementUnread(studentId) {
    if (!studentId) return;
    const key = String(studentId);
    const next = (unreadByStudent.get(key) || 0) + 1;
    unreadByStudent.set(key, next);
    renderThreadList();
  }

  function clearUnread(studentId) {
    if (!studentId) return;
    unreadByStudent.delete(String(studentId));
    renderThreadList();
  }

  async function loadAssignedThreads() {
    if (!isMentorOrPsychiatrist() || !myUserId) return;

    const rolePath = myRole === 'mentor' ? 'mentor' : 'psychiatrist';

    try {
      const response = await fetch(
        `/api/questionnaire/assigned-view?role=${encodeURIComponent(rolePath)}&userId=${encodeURIComponent(String(myUserId))}`
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        assignedThreads = [];
        renderThreadList();
        return;
      }

      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      assignedThreads = rows
        .map((row) => ({
          studentId: row?.student_id != null ? String(row.student_id) : '',
          username: String(row?.username || row?.student_id || '').trim() || 'Student',
        }))
        .filter((row) => row.studentId);

      renderThreadList();

      const requestedPeer = params.get('peerId');
      const requestedExists = requestedPeer && assignedThreads.some((row) => row.studentId === String(requestedPeer));

      if (requestedExists && String(activePeerUserId) !== String(requestedPeer)) {
        const requested = assignedThreads.find((row) => row.studentId === String(requestedPeer));
        switchThread(String(requestedPeer), 'student', requested?.username || null);
        return;
      }

      if (!activePeerUserId && assignedThreads[0]) {
        switchThread(String(assignedThreads[0].studentId), 'student', assignedThreads[0].username);
      }
    } catch (_) {
      assignedThreads = [];
      renderThreadList();
    }
  }

  function setThreadPanelVisibility() {
    if (!threadPanel) return;
    const showPanel = isMentorOrPsychiatrist();
    threadPanel.hidden = !showPanel;
    if (showPanel) renderThreadList();
  }

  function switchThread(peerUserId, peerRole = 'student', peerName = null) {
    if (!myUserId) return;

    activePeerUserId = String(peerUserId || '');
    activePeerRole = peerRole || 'student';
    clearUnread(activePeerUserId);
    clearChatWindow();

    const me = myDisplayName || myUserId;
    const subtitle = peerSubtitle(peerName || activePeerUserId, activePeerRole);
    setHeaderText(`${me} (${roleLabel(myRole)}) -> ${subtitle}`);

    const joinPayload = {
      type: 'join',
      userId: myUserId,
      authToken: sessionStorage.getItem('tuliza_session_token') || undefined,
      roleHint: myRole || undefined,
      peerUserId: activePeerUserId,
      peerRole: activePeerRole,
    };

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(joinPayload));
    } else {
      pendingJoinPayload = joinPayload;
    }

    renderThreadList();
  }

  function addMessage({ messageId, sender, senderName, text, timestamp, fromRole }) {
    if (messageId && seenMessageIds.has(String(messageId))) return;
    if (messageId) seenMessageIds.add(String(messageId));

    const type = String(sender) === String(myUserId) ? 'user' : 'counselor';

    const safeSender = String(sender ?? 'Unknown');
    const safeText = String(text ?? '');
    const safeTimestamp = String(timestamp ?? '');

    const wrap = document.createElement('div');
    wrap.className = `msg ${type}`;

    // Match existing CSS in frontend/styles.css
    // - Counselor bubble: align-left, background cream
    // - User bubble: align-right, background sage
    const senderLine = document.createElement('div');
    senderLine.style.fontWeight = '600';
    senderLine.style.marginBottom = '6px';
    const safeSenderName = String(senderName || '').trim();
    const senderLabel = safeSenderName || safeSender;
    senderLine.textContent = `${type === 'user' ? `You (${senderLabel})` : senderLabel}${fromRole ? ` (${roleLabel(fromRole)})` : ''}`;

    const textLine = document.createElement('div');
    textLine.style.whiteSpace = 'pre-wrap';
    textLine.textContent = safeText;

    wrap.appendChild(senderLine);
    wrap.appendChild(textLine);

    if (safeTimestamp) {
      const timestampLine = document.createElement('div');
      timestampLine.style.opacity = '.65';
      timestampLine.style.fontSize = '12px';
      timestampLine.style.marginTop = '6px';
      timestampLine.style.textAlign = 'right';
      timestampLine.textContent = safeTimestamp;
      wrap.appendChild(timestampLine);
    }

    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      if (pendingJoinPayload) {
        ws.send(JSON.stringify(pendingJoinPayload));
        pendingJoinPayload = null;
      }
    };

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (data.type === 'joined') {
        myRole = data.role || null;
        myDisplayName = data.displayName || data.userId;
        activePeerUserId = data.peerUserId ? String(data.peerUserId) : null;
        activePeerRole = data.peerRole || null;

        const peerName = data.peerDisplayName || data.peerUserId || 'Unassigned';
        setHeaderText(`${myDisplayName} (${roleLabel(data.role)}) -> ${peerSubtitle(peerName, data.peerRole)}`);
        setThreadPanelVisibility();
        clearChatWindow();

        if (isMentorOrPsychiatrist()) {
          clearUnread(activePeerUserId);
          if (!loadedThreadList) {
            loadedThreadList = true;
            loadAssignedThreads();
          } else {
            renderThreadList();
          }
        }
        return;
      }

      if (data.type === 'history') {
        const history = Array.isArray(data.messages) ? data.messages : [];
        history.forEach((entry) => {
          if (messageBelongsToActiveThread(entry)) {
            addMessage(entry);
          }
        });
        return;
      }

      if (data.type === 'error') {
        addMessage({
          messageId: `error-${Date.now()}`,
          sender: 'System',
          text: data.reason || 'An unknown error occurred.',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // server sends: {sender, text, timestamp, fromRole, toRole}
      if (!messageBelongsToActiveThread(data)) {
        incrementUnread(normalizeStudentIdFromMessage(data));
        return;
      }

      clearUnread(normalizeStudentIdFromMessage(data));
      addMessage(data);
    };

    ws.onclose = (event) => {
      const reason = event && event.reason ? String(event.reason) : 'Connection closed';
      setHeaderText(`Disconnected (${reason})`);
      addMessage({
        messageId: `ws-close-${Date.now()}`,
        sender: 'System',
        senderName: 'System',
        text: reason,
        timestamp: new Date().toISOString(),
        fromRole: null,
      });
    };
  }

  function joinConversation() {
    const username = nameInput.value.trim();

    if (!username) return;

    myUserId = username; // server uses userId as dashboard id

    // Update UI header
    const connectingName = myDisplayName || username;
    setHeaderText(`${connectingName} (connecting...)`);

    // Join to the server
    let storedUser = {};
    try {
      storedUser = JSON.parse(sessionStorage.getItem('tuliza_session_user') || '{}') || {};
    } catch (_) {
      storedUser = {};
    }
    const roleHint = storedUser.role || new URLSearchParams(window.location.search).get('role') || undefined;

    const joinPayload = {
      type: 'join',
      userId: myUserId,
      authToken: sessionStorage.getItem('tuliza_session_token') || undefined,
      roleHint,
      peerUserId: params.get('peerId') || undefined,
      peerRole: params.get('peerRole') || undefined,
    };

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(joinPayload));
    } else {
      pendingJoinPayload = joinPayload;
    }

    joinModal.style.display = 'none';
  }

  function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const timestamp = new Date().toLocaleString('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
    });

    ws.send(
      JSON.stringify({
        type: 'message',
        sender: myUserId,
        text,
        timestamp,
      })
    );

    input.value = '';
    input.focus();
  }

  // Events
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    joinConversation();
  });

  inputForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });

  clearBtn.addEventListener('click', () => {
    clearChatWindow();
  });

  // Start
  connect();

  const sessionUserId = sessionUser?.userId || params.get('userId') || '';
  if (sessionUserId) {
    nameInput.value = sessionUserId;
    joinConversation();
  } else {
    // Fallback for cases where session identity is unavailable.
    joinModal.style.display = 'flex';
  }
})();


// ─── State ───────────────────────────────────────────────────
let agents = [];
let questions = [];
let chatMessages = [];
let escalations = [];
let projects = [];
const activity = [];
const MAX_ACTIVITY = 200;
let selectedAgentId = null;
let activeTab = 'output';
let coordinatorStatus = 'idle';
let pendingAttachments = []; // { type: 'image', mediaType, data, name, dataUrl }
let activeProjectId = null;

// ─── WebSocket ───────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    setConnectionStatus(true);
    ws.send(JSON.stringify({ type: 'request_state' }));
  };

  ws.onclose = () => {
    setConnectionStatus(false);
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws.close();
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleServerMessage(msg);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Message Handlers ────────────────────────────────────────
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'agents':
      agents = msg.agents;
      if (!selectedAgentId && agents.length > 0) {
        selectedAgentId = agents[0].id;
      }
      renderAgents();
      renderDetail();
      break;

    case 'questions':
      questions = msg.questions;
      renderQuestions();
      break;

    case 'agent_update': {
      const idx = agents.findIndex((a) => a.id === msg.agent.id);
      if (idx >= 0) {
        agents[idx] = msg.agent;
      } else {
        agents.push(msg.agent);
        selectedAgentId = msg.agent.id;
      }
      renderAgents();
      if (msg.agent.id === selectedAgentId) {
        renderDetail();
      }
      break;
    }

    case 'question_added':
      questions.push(msg.question);
      renderQuestions();
      break;

    case 'question_removed':
      questions = questions.filter((q) => q.id !== msg.questionId);
      renderQuestions();
      break;

    case 'activity':
      activity.push(msg.entry);
      if (activity.length > MAX_ACTIVITY) activity.shift();
      renderActivityEntry(msg.entry);
      break;

    // Phase 2: Coordinator messages
    case 'chat_message':
      chatMessages.push(msg.message);
      renderChatMessage(msg.message);
      break;

    case 'chat_history':
      chatMessages = msg.messages;
      renderChat();
      break;

    case 'coordinator_status':
      coordinatorStatus = msg.status;
      renderCoordinatorStatus();
      break;

    case 'escalation_added':
      escalations.push(msg.escalation);
      renderEscalations();
      break;

    case 'escalation_removed':
      escalations = escalations.filter((e) => e.id !== msg.questionId);
      renderEscalations();
      break;

    case 'escalations':
      escalations = msg.escalations;
      renderEscalations();
      break;

    case 'projects':
      projects = msg.projects;
      // Deselect active project if it was removed
      if (activeProjectId && !projects.find((p) => p.id === activeProjectId)) {
        activeProjectId = null;
      }
      renderProjects();
      break;
  }
}

// ─── Connection Status ───────────────────────────────────────
function setConnectionStatus(connected) {
  const el = document.getElementById('connection-status');
  el.textContent = connected ? 'Connected' : 'Disconnected';
  el.className = 'conn-badge ' + (connected ? 'connected' : 'disconnected');
}

// ─── Coordinator Status ──────────────────────────────────────
function renderCoordinatorStatus() {
  const badge = document.getElementById('coordinator-status-header');
  const label = badge.querySelector('.coordinator-label');
  badge.className = 'coordinator-badge ' + coordinatorStatus;

  const labels = {
    idle: 'Coordinator Idle',
    running: 'Coordinator Active',
    stopped: 'Coordinator Stopped',
  };
  label.textContent = labels[coordinatorStatus] || 'Coordinator';

  // Stop button for coordinator
  let stopBtn = badge.querySelector('.coordinator-stop-btn');
  if (coordinatorStatus === 'running') {
    if (!stopBtn) {
      stopBtn = document.createElement('button');
      stopBtn.className = 'coordinator-stop-btn';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', () => {
        send({ type: 'stop_coordinator' });
      });
      badge.appendChild(stopBtn);
    }
  } else if (stopBtn) {
    stopBtn.remove();
  }

  // Show/hide thinking indicator
  const thinking = document.getElementById('coordinator-thinking');
  if (coordinatorStatus === 'running') {
    thinking.classList.remove('hidden');
  } else {
    thinking.classList.add('hidden');
  }
}

// ─── Chat ────────────────────────────────────────────────────
function renderChat() {
  const container = document.getElementById('chat-messages');

  if (chatMessages.length === 0) {
    container.innerHTML = '<div class="empty-state">Send a directive to start the coordinator.<br>e.g. "Create a hello world script in /tmp/test"</div>';
    return;
  }

  container.innerHTML = chatMessages.map(renderChatBubbleHtml).join('');
  attachArtifactListeners(container);
  container.scrollTop = container.scrollHeight;
}

function renderChatMessage(msg) {
  const container = document.getElementById('chat-messages');

  // Remove empty state if present
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.innerHTML = renderChatBubbleHtml(msg);
  const bubble = div.firstElementChild;
  container.appendChild(bubble);
  attachArtifactListeners(bubble);
  container.scrollTop = container.scrollHeight;
}

function renderChatBubbleHtml(msg) {
  const isHuman = msg.role === 'human';
  const time = formatTime(msg.timestamp);
  const roleLabel = isHuman ? 'You' : 'Coordinator';

  let artifactsHtml = '';
  if (msg.artifacts && msg.artifacts.length > 0) {
    artifactsHtml = '<div class="chat-artifacts">' +
      msg.artifacts.map(renderArtifactHtml).join('') +
      '</div>';
  }

  let imagesHtml = '';
  if (msg.attachments && msg.attachments.length > 0) {
    imagesHtml = '<div class="chat-images">' +
      msg.attachments.map((att) => {
        const src = `data:${att.mediaType};base64,${att.data}`;
        const title = att.name || 'image';
        return `<img class="chat-image-thumb" src="${src}" alt="${esc(title)}" title="${esc(title)}" onclick="showImageOverlay(this.src)">`;
      }).join('') +
      '</div>';
  }

  return `
    <div class="chat-bubble ${msg.role}" data-msg-id="${msg.id}">
      <div class="chat-bubble-meta">${roleLabel} · ${time}</div>
      <div class="chat-bubble-text">${esc(msg.text)}</div>
      ${imagesHtml}
      ${artifactsHtml}
    </div>
  `;
}

function renderArtifactHtml(artifact) {
  const isCollapsible = artifact.type === 'plan' || artifact.type === 'text';
  const collapsibleClass = isCollapsible ? 'collapsible' : '';
  const typeTag = artifact.language || artifact.type;

  let contentHtml;
  if (artifact.type === 'diff') {
    contentHtml = renderDiffContent(artifact.content);
  } else {
    contentHtml = esc(artifact.content);
  }

  return `
    <div class="artifact-block ${collapsibleClass}">
      <div class="artifact-header">
        <span>${esc(artifact.title)}</span>
        <span class="artifact-type-tag">${esc(typeTag)}</span>
      </div>
      <div class="artifact-content"${isCollapsible ? '' : ''}>${contentHtml}</div>
    </div>
  `;
}

function renderDiffContent(content) {
  return content.split('\n').map((line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return `<span class="diff-add">${esc(line)}</span>`;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      return `<span class="diff-del">${esc(line)}</span>`;
    } else if (line.startsWith('@@')) {
      return `<span class="diff-hunk">${esc(line)}</span>`;
    }
    return esc(line);
  }).join('\n');
}

function attachArtifactListeners(container) {
  container.querySelectorAll('.artifact-block.collapsible .artifact-header').forEach((header) => {
    header.addEventListener('click', () => {
      header.closest('.artifact-block').classList.toggle('expanded');
    });
  });
}

// ─── Escalations ─────────────────────────────────────────────
function renderEscalations() {
  const section = document.getElementById('escalations-section');
  const list = document.getElementById('escalations-list');
  const count = document.getElementById('escalation-count');
  count.textContent = String(escalations.length);

  if (escalations.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  list.innerHTML = escalations.map(renderEscalationCard).join('');

  // Attach listeners
  for (const esc of escalations) {
    attachEscalationListeners(esc);
  }
}

function renderEscalationCard(e) {
  const timeAgo = formatTimeAgo(e.createdAt);

  const questionsHtml = e.questions
    .map((qi, qIdx) => {
      const optionsHtml = qi.options
        .map(
          (opt, oIdx) => `
          <label class="option-label" data-q="${e.id}" data-qi="${qIdx}" data-oi="${oIdx}">
            <input type="${qi.multiSelect ? 'checkbox' : 'radio'}"
                   name="esc-${e.id}-${qIdx}" value="${esc(opt.label)}">
            <span class="option-info">
              <span class="option-name">${esc(opt.label)}</span>
              ${opt.description ? `<span class="option-desc">${esc(opt.description)}</span>` : ''}
            </span>
          </label>
        `)
        .join('');

      return `
        <div class="question-item" data-question-idx="${qIdx}">
          ${qi.header ? `<div style="font-family:var(--font-mono);font-size:9px;color:var(--text-dim);margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">${esc(qi.header)}</div>` : ''}
          <div class="question-text">${esc(qi.question)}</div>
          <div class="question-options">${optionsHtml}</div>
          <div class="question-other">
            <textarea placeholder="Or type a custom answer..." data-q="${e.id}" data-qi="${qIdx}"></textarea>
          </div>
        </div>
      `;
    })
    .join('<hr style="border:none;border-top:1px solid var(--border);margin:10px 0">');

  return `
    <div class="escalation-card" id="esc-${e.id}">
      <div class="question-card-header">
        <span class="question-project-tag">${esc(e.projectName)}</span>
        <span class="question-time">${timeAgo}</span>
      </div>
      <div class="escalation-reason">${esc(e.coordinatorReason)}</div>
      ${questionsHtml}
      <div class="question-actions">
        <button class="btn btn-primary submit-escalation-btn" data-q="${e.id}">Answer</button>
      </div>
    </div>
  `;
}

function attachEscalationListeners(e) {
  const card = document.getElementById(`esc-${e.id}`);
  if (!card) return;

  card.querySelectorAll('.option-label').forEach((label) => {
    const input = label.querySelector('input');
    input.addEventListener('change', () => {
      if (input.type === 'radio') {
        label.closest('.question-options').querySelectorAll('.option-label').forEach((l) => l.classList.remove('selected'));
      }
      label.classList.toggle('selected', input.checked);
    });
  });

  card.querySelector('.submit-escalation-btn').addEventListener('click', () => {
    submitEscalation(e);
  });
}

function submitEscalation(e) {
  const card = document.getElementById(`esc-${e.id}`);
  if (!card) return;

  const answers = {};

  e.questions.forEach((qi, qIdx) => {
    const customTextarea = card.querySelector(`textarea[data-qi="${qIdx}"]`);
    const customText = customTextarea?.value?.trim();

    if (customText) {
      answers[qi.question] = customText;
      return;
    }

    const checked = card.querySelectorAll(`input[name="esc-${e.id}-${qIdx}"]:checked`);
    if (checked.length > 0) {
      const values = Array.from(checked).map((el) => el.value);
      answers[qi.question] = values.join(', ');
    }
  });

  if (Object.keys(answers).length === 0) return;

  send({ type: 'answer_escalation', questionId: e.id, answers });

  // Optimistically remove
  escalations = escalations.filter((x) => x.id !== e.id);
  renderEscalations();
}

// ─── Render: Projects ────────────────────────────────────────
function renderProjects() {
  const list = document.getElementById('projects-list');

  if (projects.length === 0) {
    list.innerHTML = '';
    updateChatPlaceholder();
    return;
  }

  list.innerHTML = projects
    .map((p) => `
      <div class="project-card" data-project-id="${p.id}">
        <button class="project-remove" data-project-id="${p.id}" title="Remove project">&times;</button>
        <div class="project-card-name">${esc(p.name)}</div>
        <div class="project-card-path">${esc(p.path)}</div>
        ${p.description ? `<div class="project-card-desc">${esc(p.description)}</div>` : ''}
      </div>
    `)
    .join('');

  list.querySelectorAll('.project-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.projectId;
      send({ type: 'remove_project', projectId: id });
      if (activeProjectId === id) activeProjectId = null;
    });
  });

  // Project card click → toggle active
  list.querySelectorAll('.project-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.projectId;
      activeProjectId = activeProjectId === id ? null : id;
      renderProjectActiveState();
      updateChatPlaceholder();
    });
  });

  renderProjectActiveState();
  updateChatPlaceholder();
}

function renderProjectActiveState() {
  document.querySelectorAll('.project-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.projectId === activeProjectId);
  });
}

function updateChatPlaceholder() {
  const input = document.getElementById('chat-input');
  if (activeProjectId) {
    const project = projects.find((p) => p.id === activeProjectId);
    if (project) {
      input.placeholder = `Directive for ${project.name}...`;
      return;
    }
  }
  input.placeholder = 'Give a directive... (paste images with Ctrl+V)';
}

// Add project button
document.getElementById('add-project-btn').addEventListener('click', () => {
  const name = prompt('Project name (e.g. "crossword-clash"):');
  if (!name) return;
  const projectPath = prompt('Absolute path (e.g. /Users/archer/Programs/crossword-clash):');
  if (!projectPath) return;
  const description = prompt('Description (optional):') || undefined;
  send({ type: 'add_project', name, path: projectPath, description });
});

// ─── Render: Agents ──────────────────────────────────────────
function renderAgents() {
  const list = document.getElementById('agents-list');
  const countBadge = document.getElementById('agent-count');
  countBadge.textContent = String(agents.length);

  if (agents.length === 0) {
    list.innerHTML = '<div class="empty-state">No workers running yet.<br>Send a directive to start.</div>';
    return;
  }

  list.innerHTML = agents
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((a) => {
      const statusLabel = {
        starting: 'starting',
        working: 'working',
        waiting_for_input: 'waiting',
        completed: 'done',
        errored: 'error',
        stopped: 'stopped',
      }[a.status];

      const isSelected = a.id === selectedAgentId;

      // Live preview: last output line or last tool use
      let preview = '';
      if (a.output && a.output.length > 0) {
        preview = a.output[a.output.length - 1].split('\n').pop() || '';
      } else if (a.toolUses && a.toolUses.length > 0) {
        const last = a.toolUses[a.toolUses.length - 1];
        preview = `${last.tool}: ${last.summary}`;
      }

      // Needs attention: waiting_for_input for >30s
      const needsAttention = a.status === 'waiting_for_input' &&
        (Date.now() - a.createdAt > 30000);

      const canStop = ['starting', 'working', 'waiting_for_input'].includes(a.status);

      return `
        <div class="agent-card ${isSelected ? 'selected' : ''}" data-agent-id="${a.id}">
          <div class="agent-card-header">
            <span class="status-dot ${a.status}"></span>
            <span class="agent-name">${esc(a.projectName)}</span>
            ${canStop ? `<button class="btn-stop-agent" data-agent-id="${a.id}">Stop</button>` : ''}
            <span class="agent-status-label">${statusLabel}</span>
          </div>
          ${preview ? `<div class="agent-preview">${esc(truncate(preview, 80))}</div>` : ''}
          <div class="agent-meta">
            <span>$${a.totalCostUsd.toFixed(4)}</span>
            <span>${a.numTurns}t</span>
            <span>${a.toolUses ? a.toolUses.length : 0} tools</span>
            ${a.error ? `<span style="color:var(--red)">${esc(truncate(a.error, 30))}</span>` : ''}
          </div>
          ${needsAttention ? '<div class="needs-attention">Needs attention</div>' : ''}
        </div>
      `;
    })
    .join('');

  // Stop button handlers (must be before card click to stop propagation)
  list.querySelectorAll('.btn-stop-agent').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      send({ type: 'stop_agent', agentId: btn.dataset.agentId });
    });
  });

  // Click handlers
  list.querySelectorAll('.agent-card').forEach((card) => {
    card.addEventListener('click', () => {
      selectedAgentId = card.dataset.agentId;
      // Auto-expand detail panel
      document.getElementById('agent-detail-section').classList.remove('collapsed');
      renderAgents();
      renderDetail();
    });
  });
}

// ─── Render: Agent Detail ────────────────────────────────────
function renderDetail() {
  const detail = document.getElementById('agent-detail');
  const title = document.getElementById('detail-title');

  const agent = agents.find((a) => a.id === selectedAgentId);
  if (!agent) {
    title.textContent = 'Agent Output';
    detail.innerHTML = '<div class="empty-state">Select a worker to view its output.</div>';
    return;
  }

  title.textContent = agent.projectName;

  if (activeTab === 'output') {
    renderOutputTab(agent, detail);
  } else {
    renderToolsTab(agent, detail);
  }
}

function renderOutputTab(agent, container) {
  let html = '';

  if (agent.resultText) {
    html += `
      <div class="output-block result-block">
        <div class="result-block-header">Result</div>
        ${esc(agent.resultText)}
      </div>
    `;
  }

  if (agent.error) {
    html += `
      <div class="output-block error-block">
        <div class="error-block-header">Error</div>
        ${esc(agent.error)}
      </div>
    `;
  }

  if (agent.output && agent.output.length > 0) {
    for (const text of agent.output) {
      html += `<div class="output-block">${esc(text)}</div>`;
    }
  }

  if (!html) {
    html = '<div class="empty-state">No output yet. The worker is starting...</div>';
  }

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function renderToolsTab(agent, container) {
  if (!agent.toolUses || agent.toolUses.length === 0) {
    container.innerHTML = '<div class="empty-state">No tool usage recorded yet.</div>';
    return;
  }

  container.innerHTML = agent.toolUses
    .map(
      (t) => `
      <div class="tool-entry">
        <span class="tool-entry-time">${formatTime(t.timestamp)}</span>
        <span class="tool-entry-name">${esc(t.tool)}</span>
        <span class="tool-entry-summary">${esc(t.summary)}</span>
      </div>
    `)
    .join('');

  container.scrollTop = container.scrollHeight;
}

// Tab switching
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderDetail();
  });
});

// ─── Agent Detail Collapse ────────────────────────────────────
document.getElementById('detail-collapse-btn').addEventListener('click', () => {
  document.getElementById('agent-detail-section').classList.toggle('collapsed');
});

// ─── Render: Questions (Phase 1 fallback) ────────────────────
function renderQuestions() {
  const list = document.getElementById('questions-list');
  const count = document.getElementById('question-count');
  count.textContent = String(questions.length);

  if (questions.length === 0) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = questions
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((q) => renderQuestionCard(q))
    .join('');

  for (const q of questions) {
    attachQuestionListeners(q);
  }
}

function renderQuestionCard(q) {
  const timeAgo = formatTimeAgo(q.createdAt);

  const questionsHtml = q.questions
    .map((qi, qIdx) => {
      const optionsHtml = qi.options
        .map(
          (opt, oIdx) => `
          <label class="option-label" data-q="${q.id}" data-qi="${qIdx}" data-oi="${oIdx}">
            <input type="${qi.multiSelect ? 'checkbox' : 'radio'}"
                   name="q-${q.id}-${qIdx}" value="${esc(opt.label)}">
            <span class="option-info">
              <span class="option-name">${esc(opt.label)}</span>
              ${opt.description ? `<span class="option-desc">${esc(opt.description)}</span>` : ''}
            </span>
          </label>
        `)
        .join('');

      return `
        <div class="question-item" data-question-idx="${qIdx}">
          ${qi.header ? `<div style="font-family:var(--font-mono);font-size:9px;color:var(--text-dim);margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">${esc(qi.header)}</div>` : ''}
          <div class="question-text">${esc(qi.question)}</div>
          <div class="question-options">${optionsHtml}</div>
          <div class="question-other">
            <textarea placeholder="Or type a custom answer..." data-q="${q.id}" data-qi="${qIdx}"></textarea>
          </div>
        </div>
      `;
    })
    .join('<hr style="border:none;border-top:1px solid var(--border);margin:10px 0">');

  return `
    <div class="question-card" id="qcard-${q.id}">
      <div class="question-card-header">
        <span class="question-project-tag">${esc(q.projectName)}</span>
        <span class="question-time">${timeAgo}</span>
      </div>
      ${questionsHtml}
      <div class="question-actions">
        <button class="btn btn-primary submit-answer-btn" data-q="${q.id}">Submit Answer</button>
      </div>
    </div>
  `;
}

function attachQuestionListeners(q) {
  const card = document.getElementById(`qcard-${q.id}`);
  if (!card) return;

  card.querySelectorAll('.option-label').forEach((label) => {
    const input = label.querySelector('input');
    input.addEventListener('change', () => {
      if (input.type === 'radio') {
        label.closest('.question-options').querySelectorAll('.option-label').forEach((l) => l.classList.remove('selected'));
      }
      label.classList.toggle('selected', input.checked);
    });
  });

  card.querySelector('.submit-answer-btn').addEventListener('click', () => {
    submitAnswer(q);
  });
}

function submitAnswer(q) {
  const card = document.getElementById(`qcard-${q.id}`);
  if (!card) return;

  const answers = {};

  q.questions.forEach((qi, qIdx) => {
    const customTextarea = card.querySelector(`textarea[data-qi="${qIdx}"]`);
    const customText = customTextarea?.value?.trim();

    if (customText) {
      answers[qi.question] = customText;
      return;
    }

    const checked = card.querySelectorAll(`input[name="q-${q.id}-${qIdx}"]:checked`);
    if (checked.length > 0) {
      const values = Array.from(checked).map((el) => el.value);
      answers[qi.question] = values.join(', ');
    }
  });

  if (Object.keys(answers).length === 0) return;

  send({ type: 'answer', questionId: q.id, answers });

  questions = questions.filter((x) => x.id !== q.id);
  renderQuestions();
}

// ─── Render: Activity ────────────────────────────────────────
function renderActivityEntry(entry) {
  const list = document.getElementById('activity-list');

  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = 'activity-entry';
  div.innerHTML = `
    <span class="activity-time">${formatTime(entry.timestamp)}</span>
    <span class="activity-project">${esc(entry.projectName)}</span>
    <span class="activity-message">${esc(entry.message)}</span>
  `;

  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

// ─── Chat Input & Attachments ────────────────────────────────
document.getElementById('chat-input-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  let text = input.value.trim();
  if (!text && pendingAttachments.length === 0) return;

  // Prepend project context when active
  if (activeProjectId && text) {
    const project = projects.find((p) => p.id === activeProjectId);
    if (project) {
      text = `[Project: ${project.name}] ${text}`;
    }
  }

  const msg = { type: 'directive', text: text || '(see attached)' };
  if (pendingAttachments.length > 0) {
    msg.attachments = pendingAttachments.map(({ type, mediaType, data, name }) => ({ type, mediaType, data, name }));
  }
  send(msg);

  input.value = '';
  pendingAttachments = [];
  renderAttachmentPreviews();
});

// Attach button → open file picker
document.getElementById('chat-attach-btn').addEventListener('click', () => {
  document.getElementById('chat-file-input').click();
});

// File input change
document.getElementById('chat-file-input').addEventListener('change', (e) => {
  for (const file of e.target.files) {
    addFileAttachment(file);
  }
  e.target.value = '';
});

// Paste support (Ctrl+V for screenshots)
document.getElementById('chat-input').addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) addFileAttachment(file);
    }
  }
});

function addFileAttachment(file) {
  if (!file.type.startsWith('image/')) return;

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    // Extract base64 data (strip the data:image/...;base64, prefix)
    const base64 = dataUrl.split(',')[1];
    pendingAttachments.push({
      type: 'image',
      mediaType: file.type,
      data: base64,
      name: file.name,
      dataUrl, // keep for preview display
    });
    renderAttachmentPreviews();
  };
  reader.readAsDataURL(file);
}

function renderAttachmentPreviews() {
  const container = document.getElementById('chat-attachments');

  if (pendingAttachments.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = pendingAttachments.map((att, idx) => `
    <div class="attachment-preview" data-idx="${idx}">
      <img src="${att.dataUrl}" alt="${esc(att.name || 'image')}">
      <button class="attachment-remove" data-idx="${idx}" title="Remove">&times;</button>
    </div>
  `).join('');

  container.querySelectorAll('.attachment-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      pendingAttachments.splice(idx, 1);
      renderAttachmentPreviews();
    });
  });
}

// Fullscreen image overlay
function showImageOverlay(src) {
  const overlay = document.createElement('div');
  overlay.className = 'image-overlay';
  overlay.innerHTML = `<img src="${src}">`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}
// Make it globally accessible for inline onclick
window.showImageOverlay = showImageOverlay;

// ─── Utilities ───────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '\u2026' : str;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatTimeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return formatTime(ts);
}

// Periodically refresh agent cards to update "needs attention" badges
setInterval(() => {
  if (agents.some((a) => a.status === 'waiting_for_input')) {
    renderAgents();
  }
}, 10000);

// ─── Init ────────────────────────────────────────────────────
renderProjects();
renderAgents();
renderQuestions();
renderChat();
renderDetail();
renderCoordinatorStatus();
renderEscalations();
document.getElementById('activity-list').innerHTML = '<div class="empty-state">Activity will appear here<br>as workers run.</div>';
connect();

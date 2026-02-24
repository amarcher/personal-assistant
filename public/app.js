// State
let agents = [];
let questions = [];
const activity = [];
const MAX_ACTIVITY = 200;
let selectedAgentId = null;
let activeTab = 'output'; // 'output' | 'tools'

// WebSocket
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

// Message handlers
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'agents':
      agents = msg.agents;
      // Auto-select first agent if none selected
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
        // Auto-select newly added agent
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
  }
}

// Connection status
function setConnectionStatus(connected) {
  const el = document.getElementById('connection-status');
  el.textContent = connected ? 'Connected' : 'Disconnected';
  el.className = 'status-badge ' + (connected ? 'connected' : 'disconnected');
}

// Render: Agents
function renderAgents() {
  const list = document.getElementById('agents-list');

  if (agents.length === 0) {
    list.innerHTML = '<div class="empty-state">No agents running.<br>Click "+ New Agent" to start one.</div>';
    return;
  }

  list.innerHTML = agents
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((a) => {
      const statusLabel = {
        starting: 'Starting...',
        working: 'Working',
        waiting_for_input: 'Waiting for input',
        completed: 'Completed',
        errored: 'Error',
      }[a.status];

      const isSelected = a.id === selectedAgentId;

      return `
        <div class="agent-card ${isSelected ? 'selected' : ''}" data-agent-id="${a.id}">
          <div class="agent-card-header">
            <span class="status-dot ${a.status}"></span>
            <span class="agent-name">${esc(a.projectName)}</span>
            <span class="agent-status-label">${statusLabel}</span>
          </div>
          <div class="agent-prompt">${esc(a.prompt)}</div>
          <div class="agent-meta">
            <span>$${a.totalCostUsd.toFixed(4)}</span>
            <span>${a.numTurns} turns</span>
            <span>${a.toolUses ? a.toolUses.length : 0} tools</span>
            ${a.error ? `<span style="color:var(--red)">${esc(truncate(a.error, 40))}</span>` : ''}
          </div>
        </div>
      `;
    })
    .join('');

  // Click handlers for selection
  list.querySelectorAll('.agent-card').forEach((card) => {
    card.addEventListener('click', () => {
      selectedAgentId = card.dataset.agentId;
      renderAgents();
      renderDetail();
    });
  });
}

// Render: Agent detail (output / tools tabs)
function renderDetail() {
  const detail = document.getElementById('agent-detail');
  const title = document.getElementById('detail-title');

  const agent = agents.find((a) => a.id === selectedAgentId);
  if (!agent) {
    title.textContent = 'Agent Output';
    detail.innerHTML = '<div class="empty-state">Select an agent to view its output.</div>';
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

  // Result summary at the top if completed
  if (agent.resultText) {
    html += `
      <div class="output-block result-block">
        <div class="result-block-header">Result</div>
        ${esc(agent.resultText)}
      </div>
    `;
  }

  // Error at the top if errored
  if (agent.error) {
    html += `
      <div class="output-block error-block">
        <div class="error-block-header">Error</div>
        ${esc(agent.error)}
      </div>
    `;
  }

  // Assistant output blocks
  if (agent.output && agent.output.length > 0) {
    for (const text of agent.output) {
      html += `<div class="output-block">${esc(text)}</div>`;
    }
  }

  if (!html) {
    html = '<div class="empty-state">No output yet. The agent is working...</div>';
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
    `
    )
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

// Render: Questions
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

  // Attach event listeners
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
        `
        )
        .join('');

      return `
        <div class="question-item" data-question-idx="${qIdx}">
          ${qi.header ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">${esc(qi.header)}</div>` : ''}
          <div class="question-text">${esc(qi.question)}</div>
          <div class="question-options">${optionsHtml}</div>
          <div class="question-other">
            <textarea placeholder="Or type a custom answer..." data-q="${q.id}" data-qi="${qIdx}"></textarea>
          </div>
        </div>
      `;
    })
    .join('<hr style="border:none;border-top:1px solid var(--border);margin:12px 0">');

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

  // Option label click styling
  card.querySelectorAll('.option-label').forEach((label) => {
    const input = label.querySelector('input');
    input.addEventListener('change', () => {
      if (input.type === 'radio') {
        label.closest('.question-options').querySelectorAll('.option-label').forEach((l) => l.classList.remove('selected'));
      }
      label.classList.toggle('selected', input.checked);
    });
  });

  // Submit button
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

    // Gather selected options
    const checked = card.querySelectorAll(`input[name="q-${q.id}-${qIdx}"]:checked`);
    if (checked.length > 0) {
      const values = Array.from(checked).map((el) => el.value);
      answers[qi.question] = values.join(', ');
    }
  });

  // Must have at least one answer
  if (Object.keys(answers).length === 0) return;

  send({ type: 'answer', questionId: q.id, answers });

  // Optimistically remove from UI
  questions = questions.filter((x) => x.id !== q.id);
  renderQuestions();
}

// Render: Activity
function renderActivityEntry(entry) {
  const list = document.getElementById('activity-list');

  // Remove empty state if present
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

// New agent form
document.getElementById('new-agent-btn').addEventListener('click', () => {
  document.getElementById('new-agent-form').classList.toggle('hidden');
});

document.getElementById('cancel-agent-btn').addEventListener('click', () => {
  document.getElementById('new-agent-form').classList.add('hidden');
});

document.getElementById('new-agent-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const projectName = document.getElementById('agent-project-name').value.trim();
  const projectPath = document.getElementById('agent-project-path').value.trim();
  const prompt = document.getElementById('agent-prompt').value.trim();

  if (!projectName || !projectPath || !prompt) return;

  send({ type: 'start_agent', projectName, projectPath, prompt });

  // Reset form
  document.getElementById('agent-project-name').value = '';
  document.getElementById('agent-project-path').value = '';
  document.getElementById('agent-prompt').value = '';
  document.getElementById('new-agent-form').classList.add('hidden');
});

// Utilities
function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
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

// Init
renderAgents();
renderQuestions();
renderDetail();
document.getElementById('activity-list').innerHTML = '<div class="empty-state">Activity will appear here as agents work.</div>';
connect();

const userId = getOrCreateUserId();
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const elements = Object.fromEntries([
  'sidebar', 'mobile-scrim', 'new-chat', 'open-sidebar', 'close-sidebar', 'conversation-list',
  'history-filter', 'history-count', 'clear-history', 'today-label', 'active-title', 'welcome',
  'message-list', 'chat-scroll', 'scroll-anchor', 'composer', 'message-input', 'send-button',
  'stop-button', 'memory-status', 'status-dot', 'status-label', 'toast',
].map((id) => [id, document.getElementById(id)]));

let activeConversationId = null;
let conversations = [];
let messages = [];
let activeAbort = null;
let activeAbortMode = null;
let toastTimer = null;

function getOrCreateUserId() {
  let id = localStorage.getItem('minimi-user-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('minimi-user-id', id);
  }
  return id;
}

function apiUrl(path) {
  return `${path}${path.includes('?') ? '&' : '?'}userId=${encodeURIComponent(userId)}`;
}

async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function setToday() {
  elements['today-label'].textContent = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date());
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 3600);
}

function setBusy(busy) {
  elements['send-button'].hidden = busy;
  elements['stop-button'].hidden = !busy;
  elements['message-input'].disabled = busy;
  if (!busy) elements['message-input'].focus();
}

function showSidebar(open) {
  elements.sidebar.classList.toggle('mobile-open', open);
  document.body.classList.toggle('sidebar-open', open);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function addCitationMarkers(content, markers = []) {
  let output = content;
  const seen = new Set();
  const ordered = [...markers].filter((marker) => Number.isInteger(marker.endIndex) && Number.isInteger(marker.sourceIndex))
    .sort((a, b) => b.endIndex - a.endIndex);
  for (const marker of ordered) {
    const key = `${marker.endIndex}:${marker.sourceIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const index = Math.max(0, Math.min(marker.endIndex, output.length));
    output = `${output.slice(0, index)} \uE000CITATION_${marker.sourceIndex}\uE001${output.slice(index)}`;
  }
  return output;
}

function renderInline(text, messageId, citationCount) {
  let output = escapeHtml(text);
  const code = [];
  output = output.replace(/`([^`]+)`/g, (_match, value) => {
    const index = code.push(`<code>${value}</code>`) - 1;
    return `\u0000CODE${index}\u0000`;
  });
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, rawUrl) => {
    const url = safeUrl(rawUrl.replaceAll('&amp;', '&'));
    return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  output = output.replace(/\uE000CITATION_(\d+)\uE001/g, (_match, sourceIndexValue) => {
    const sourceIndex = Number(sourceIndexValue);
    if (sourceIndex < 0 || sourceIndex >= citationCount) return '';
    const number = sourceIndex + 1;
    return `<a class="citation-mark" href="#source-${messageId}-${sourceIndex}" aria-label="Source ${number}">${number}</a>`;
  });
  output = output.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => code[Number(index)] || '');
  return output;
}

function renderMarkdown(text, messageId, citations = [], markers = []) {
  const markedText = addCitationMarkers(text, markers);
  const blocks = markedText.replace(/\r/g, '').split(/```/);
  let html = '';
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (index % 2 === 1) {
      const lines = block.split('\n');
      const language = lines[0].trim().match(/^[\w+-]+$/) ? lines.shift().trim() : '';
      html += `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(lines.join('\n').replace(/^\n|\n$/g, ''))}</code></pre>`;
      continue;
    }
    let list = null;
    let paragraph = [];
    const closeList = () => {
      if (list) html += `</${list}>`;
      list = null;
    };
    const flushParagraph = () => {
      if (paragraph.length) html += `<p>${paragraph.map((line) => renderInline(line, messageId, citations.length)).join('<br>')}</p>`;
      paragraph = [];
    };
    const lines = block.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (/^\s*\|.*\|\s*$/.test(line)) {
        const tableLines = [];
        while (lineIndex < lines.length && /^\s*\|.*\|\s*$/.test(lines[lineIndex])) {
          tableLines.push(lines[lineIndex]);
          lineIndex += 1;
        }
        lineIndex -= 1;
        flushParagraph(); closeList();
        const cells = (value) => value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
        const rows = tableLines.map(cells);
        const header = rows.shift() || [];
        if (rows[0]?.every((cell) => /^:?-{3,}:?$/.test(cell))) rows.shift();
        html += '<div class="table-scroll"><table><thead><tr>';
        for (const cell of header) html += `<th>${renderInline(cell, messageId, citations.length)}</th>`;
        html += '</tr></thead><tbody>';
        for (const row of rows) {
          html += '<tr>';
          for (let column = 0; column < header.length; column += 1) {
            html += `<td>${renderInline(row[column] || '', messageId, citations.length)}</td>`;
          }
          html += '</tr>';
        }
        html += '</tbody></table></div>';
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
      if (heading) {
        flushParagraph(); closeList();
        const level = Math.min(heading[1].length + 1, 4);
        html += `<h${level}>${renderInline(heading[2], messageId, citations.length)}</h${level}>`;
      } else if (unordered || ordered) {
        flushParagraph();
        const nextList = unordered ? 'ul' : 'ol';
        if (list !== nextList) { closeList(); html += `<${nextList}>`; list = nextList; }
        html += `<li>${renderInline((unordered || ordered)[1], messageId, citations.length)}</li>`;
      } else if (/^>\s?/.test(line)) {
        flushParagraph(); closeList();
        html += `<blockquote>${renderInline(line.replace(/^>\s?/, ''), messageId, citations.length)}</blockquote>`;
      } else if (!line.trim()) {
        flushParagraph(); closeList();
      } else {
        closeList(); paragraph.push(line);
      }
    }
    flushParagraph(); closeList();
  }
  return html;
}

function displayDate(iso) {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function renderSources(message, container) {
  if (!message.citations?.length) return;
  const section = document.createElement('div');
  section.className = 'sources';
  const label = document.createElement('div');
  label.className = 'sources-label';
  label.textContent = 'Sources';
  section.append(label);
  message.citations.forEach((citation, index) => {
    const url = safeUrl(citation.url);
    if (!url) return;
    const link = document.createElement('a');
    link.className = 'source-card';
    link.id = `source-${message.id}-${index}`;
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const number = document.createElement('span');
    number.className = 'source-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    copy.className = 'source-copy';
    const title = document.createElement('strong');
    title.textContent = citation.title || new URL(url).hostname;
    const host = document.createElement('small');
    host.textContent = new URL(url).hostname.replace(/^www\./, '');
    copy.append(title, host);
    const arrow = document.createElement('span');
    arrow.className = 'source-arrow';
    arrow.textContent = '↗';
    link.append(number, copy, arrow);
    section.append(link);
  });
  if (section.querySelector('.source-card')) container.append(section);
}

function renderMessage(message) {
  const wrapper = document.createElement('article');
  wrapper.className = `message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`;
  wrapper.dataset.messageId = message.id;

  if (message.role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'assistant-avatar';
    avatar.textContent = 'm';
    wrapper.append(avatar);
  }

  const main = document.createElement('div');
  main.className = 'message-main';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const sender = document.createElement('span');
  sender.className = 'message-sender';
  sender.textContent = message.role === 'user' ? 'You' : 'minimi';
  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = message.createdAt || new Date().toISOString();
  time.textContent = displayDate(time.dateTime);
  meta.append(sender, time);

  const body = document.createElement('div');
  body.className = 'message-body';
  if (message.role === 'assistant') {
    const citationInfo = Array.isArray(message.citations)
      ? { citations: message.citations, markers: message.markers || [] }
      : { citations: message.citations?.sources || [], markers: message.citations?.markers || [] };
    body.innerHTML = renderMarkdown(message.content, message.id, citationInfo.citations, citationInfo.markers);
    main.append(meta, body);
    renderSources({ ...message, citations: citationInfo.citations }, main);
  } else {
    body.textContent = message.content;
    main.append(meta, body);
  }
  wrapper.append(main);
  return wrapper;
}

function renderConversation() {
  elements.welcome.hidden = messages.length > 0;
  elements['message-list'].replaceChildren(...messages.map(renderMessage));
  elements['active-title'].textContent = activeConversationId
    ? conversations.find((item) => item.id === activeConversationId)?.title || 'Conversation'
    : 'New conversation';
  requestAnimationFrame(scrollToBottom);
}

function scrollToBottom() {
  elements['scroll-anchor'].scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function renderConversationList() {
  const filter = elements['history-filter'].value.trim().toLowerCase();
  const visible = conversations.filter((conversation) => conversation.title.toLowerCase().includes(filter));
  elements['history-count'].textContent = String(conversations.length);
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = filter ? 'No matching chats' : 'Your chats will show up here';
    elements['conversation-list'].replaceChildren(empty);
    return;
  }

  const groups = new Map();
  for (const conversation of visible) {
    const date = new Date(conversation.updatedAt);
    const key = date.toDateString() === new Date().toDateString() ? 'Today'
      : (Date.now() - date.getTime()) < 7 * 86_400_000 ? 'Previous 7 days' : 'Older';
    const items = groups.get(key) || [];
    items.push(conversation);
    groups.set(key, items);
  }

  const fragment = document.createDocumentFragment();
  for (const [label, items] of groups) {
    const section = document.createElement('section');
    section.className = 'history-group';
    const heading = document.createElement('h2');
    heading.textContent = label;
    section.append(heading);
    for (const conversation of items) {
      const row = document.createElement('div');
      row.className = `history-row${conversation.id === activeConversationId ? ' active' : ''}`;
      const open = document.createElement('button');
      open.className = 'history-item';
      open.type = 'button';
      open.title = conversation.title;
      open.addEventListener('click', () => openConversation(conversation.id));
      const title = document.createElement('span');
      title.className = 'history-title';
      title.textContent = conversation.title;
      const date = document.createElement('span');
      date.className = 'history-date';
      date.textContent = displayDate(conversation.updatedAt);
      open.append(title, date);
      const remove = document.createElement('button');
      remove.className = 'history-delete';
      remove.type = 'button';
      remove.setAttribute('aria-label', `Delete ${conversation.title}`);
      remove.title = 'Delete chat';
      remove.textContent = '×';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!window.confirm('Delete this conversation from local history?')) return;
        try {
          await api(`/api/conversations/${encodeURIComponent(conversation.id)}`, { method: 'DELETE' });
          if (activeConversationId === conversation.id) startNewChat();
          await loadConversations();
        } catch (error) { showToast(error.message); }
      });
      row.append(open, remove);
      section.append(row);
    }
    fragment.append(section);
  }
  elements['conversation-list'].replaceChildren(fragment);
}

async function loadConversations() {
  const data = await api('/api/conversations');
  conversations = data.conversations;
  renderConversationList();
  renderConversation();
}

async function openConversation(id) {
  if (activeAbort) return;
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}`);
    activeConversationId = id;
    messages = data.messages;
    renderConversationList();
    renderConversation();
    showSidebar(false);
  } catch (error) { showToast(error.message); }
}

function startNewChat() {
  if (activeAbort) {
    activeAbortMode = 'navigation';
    activeAbort.abort();
  }
  activeConversationId = null;
  messages = [];
  elements['memory-status'].hidden = true;
  if (!activeAbort) setBusy(false);
  renderConversationList();
  renderConversation();
  showSidebar(false);
}

function updateConversation(conversation) {
  const existing = conversations.find((item) => item.id === conversation.id);
  if (existing) Object.assign(existing, conversation);
  else conversations.unshift(conversation);
  conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  renderConversationList();
  elements['active-title'].textContent = conversation.title;
}

function parseSseChunk(chunk) {
  const events = [];
  for (const block of chunk.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/);
    const type = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (data) {
      try { events.push({ type, data: JSON.parse(data) }); } catch {}
    }
  }
  return events;
}

async function streamMessage(question) {
  const createdAt = new Date().toISOString();
  const userMessage = { id: crypto.randomUUID(), role: 'user', content: question, createdAt };
  const assistantMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', createdAt: new Date().toISOString(), citations: [] };
  messages.push(userMessage, assistantMessage);
  renderConversation();
  const assistantElement = elements['message-list'].lastElementChild;
  const body = assistantElement.querySelector('.message-body');
  const metaStatus = document.createElement('div');
  metaStatus.className = 'thinking-status';
  metaStatus.textContent = 'Thinking…';
  assistantElement.querySelector('.message-main').append(metaStatus);
  elements['memory-status'].hidden = true;

  activeAbort = new AbortController();
  activeAbortMode = null;
  setBusy(true);
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Minimi-User': userId },
      body: JSON.stringify({ userId, conversationId: activeConversationId, message: question, timezone }),
      signal: activeAbort.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const sections = buffer.split(/\r?\n\r?\n/);
      buffer = sections.pop() || '';
      for (const event of parseSseChunk(sections.join('\n\n'))) {
        if (event.type === 'meta') {
          activeConversationId = event.data.conversation.id;
          Object.assign(userMessage, event.data.userMessage);
          assistantMessage.createdAt = new Date().toISOString();
          updateConversation(event.data.conversation);
          renderConversationList();
        } else if (event.type === 'status') {
          metaStatus.textContent = event.data.text;
        } else if (event.type === 'memory') {
          const reference = event.data.dateReference;
          elements['memory-status'].textContent = reference
            ? reference.found ? `Found ${reference.messageCount} saved turn${reference.messageCount === 1 ? '' : 's'} for ${reference.start}.` : `No saved turns found for ${reference.start}.`
            : event.data.retrievedCount ? `Looking at ${event.data.retrievedCount} relevant saved turn${event.data.retrievedCount === 1 ? '' : 's'}.` : '';
          elements['memory-status'].hidden = !elements['memory-status'].textContent;
        } else if (event.type === 'delta') {
          assistantMessage.content += event.data.text;
          metaStatus.remove();
          body.textContent = assistantMessage.content;
          scrollToBottom();
        } else if (event.type === 'done') {
          const finalMessage = event.data.assistantMessage;
          Object.assign(assistantMessage, finalMessage);
          const index = messages.findIndex((item) => item.id === assistantMessage.id);
          if (index >= 0) messages[index] = assistantMessage;
          metaStatus.remove();
          assistantElement.replaceWith(renderMessage(assistantMessage));
          elements['memory-status'].hidden = true;
          await loadConversations();
        } else if (event.type === 'error') {
          throw new Error(event.data.message || 'Something went wrong.');
        }
      }
    }
  } catch (error) {
    metaStatus.remove();
    if (error.name === 'AbortError') {
      if (activeAbortMode !== 'navigation') {
        messages = messages.filter((item) => item.id !== assistantMessage.id);
        renderConversation();
        showToast('Response stopped. Your question is saved in this chat.');
      }
    } else {
      assistantMessage.content = error.message;
      assistantMessage.error = true;
      body.textContent = error.message;
      body.classList.add('error-text');
      showToast(error.message);
      renderConversation();
    }
  } finally {
    activeAbort = null;
    activeAbortMode = null;
    setBusy(false);
  }
}

function resizeInput() {
  elements['message-input'].style.height = 'auto';
  elements['message-input'].style.height = `${Math.min(elements['message-input'].scrollHeight, 180)}px`;
}

elements.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const question = elements['message-input'].value.trim();
  if (!question || activeAbort) return;
  elements['message-input'].value = '';
  resizeInput();
  streamMessage(question);
});

elements['message-input'].addEventListener('input', resizeInput);
elements['message-input'].addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements['new-chat'].addEventListener('click', startNewChat);
elements['open-sidebar'].addEventListener('click', () => showSidebar(true));
elements['close-sidebar'].addEventListener('click', () => showSidebar(false));
elements['mobile-scrim'].addEventListener('click', () => showSidebar(false));
elements['history-filter'].addEventListener('input', renderConversationList);
elements['stop-button'].addEventListener('click', () => {
  if (activeAbort) {
    activeAbortMode = 'user';
    activeAbort.abort();
  }
});
elements['clear-history'].addEventListener('click', async () => {
  if (!conversations.length) return showToast('There is no saved chat history to clear.');
  if (!window.confirm('Clear all saved conversations from this device?')) return;
  try {
    await api('/api/history', { method: 'DELETE' });
    startNewChat();
    conversations = [];
    renderConversationList();
    showToast('Saved chat history cleared.');
  } catch (error) { showToast(error.message); }
});

document.querySelectorAll('.starter-card').forEach((card) => card.addEventListener('click', () => {
  elements['message-input'].value = card.dataset.prompt;
  resizeInput();
  elements['message-input'].focus();
}));

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    startNewChat();
    elements['message-input'].focus();
  }
  if (event.key === 'Escape') showSidebar(false);
});

async function initialize() {
  setToday();
  try {
    const health = await fetch('/api/health').then((response) => response.json());
    elements['status-dot'].classList.toggle('is-offline', !health.ready);
    elements['status-label'].textContent = health.ready ? `Search ready · ${health.model}` : 'Add API key to start';
    if (!health.ready) showToast('Add OPENAI_API_KEY to .env, then restart minimi.');
    await loadConversations();
  } catch (error) {
    elements['status-dot'].classList.add('is-offline');
    elements['status-label'].textContent = 'Server unavailable';
    showToast(error.message);
  }
}

initialize();

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// ---------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

/** Erzeugt ein DOM-Element. Texte werden immer als Text (nicht HTML) eingefügt. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'value' || (key in node && typeof value !== 'string')) node[key] = value;
    else if (value != null && value !== false) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

let toastTimer;
function showError(err) {
  console.error(err);
  const toast = $('#toast');
  toast.textContent = err?.message ?? String(err);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 5000);
}

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* egal */ } },
};

function show(viewId) {
  for (const id of ['config-view', 'auth-view', 'app-view']) {
    $('#' + id).hidden = id !== viewId;
  }
}

// ---------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------
const state = {
  user: null,
  profiles: [],
  lists: [],
  tasks: [],
  activeListId: Number(storage.get('activeListId')) || null,
  showDone: storage.get('showDone') !== 'false',
  filterAssignee: storage.get('filterAssignee') || 'all',
  editing: null, // { id, title, note } – Aufgabe, die gerade bearbeitet wird
};

let sb;
let channel;

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------
function main() {
  if (!SUPABASE_URL || SUPABASE_URL.includes('DEIN-PROJEKT') || SUPABASE_ANON_KEY.includes('DEIN-')) {
    show('config-view');
    return;
  }

  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  setupAuthForm();
  setupAppEvents();

  let initialized = false;
  sb.auth.onAuthStateChange((_event, session) => {
    const user = session?.user ?? null;
    if (initialized && user?.id === state.user?.id) return;
    initialized = true;
    state.user = user;
    if (user) startApp();
    else stopApp();
  });
}

// ---------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------
function setupAuthForm() {
  let registerMode = false;
  const form = $('#auth-form');
  const message = $('#auth-message');

  const setMode = (reg) => {
    registerMode = reg;
    $('#auth-title').textContent = reg ? 'Registrieren' : 'Anmelden';
    $('#auth-submit').textContent = reg ? 'Konto erstellen' : 'Anmelden';
    $('#auth-toggle').textContent = reg ? 'Schon ein Konto? Anmelden' : 'Noch kein Konto? Registrieren';
    $('#name-field').hidden = !reg;
    form.name.required = reg;
    form.password.autocomplete = reg ? 'new-password' : 'current-password';
    message.hidden = true;
  };

  $('#auth-toggle').addEventListener('click', (e) => {
    e.preventDefault();
    setMode(!registerMode);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    message.hidden = true;
    const email = form.email.value.trim();
    const password = form.password.value;
    const button = $('#auth-submit');
    button.disabled = true;
    try {
      if (registerMode) {
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { data: { display_name: form.name.value.trim() } },
        });
        if (error) throw error;
        if (!data.session) {
          message.textContent = 'Konto erstellt. Bitte bestätige deine E-Mail-Adresse und melde dich dann an.';
          message.hidden = false;
          setMode(false);
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      message.textContent = err.message;
      message.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------
// App starten / beenden
// ---------------------------------------------------------------------
async function startApp() {
  show('app-view');
  $('#show-done').checked = state.showDone;
  $('#filter-assignee').value = state.filterAssignee;

  channel = sb
    .channel('db-changes')
    .on('postgres_changes', { event: '*', schema: 'public' }, scheduleReload)
    .subscribe();

  await loadAll();
}

function stopApp() {
  if (channel) sb.removeChannel(channel);
  channel = null;
  Object.assign(state, { profiles: [], lists: [], tasks: [], editing: null });
  show('auth-view');
}

// ---------------------------------------------------------------------
// Daten laden
// ---------------------------------------------------------------------
let reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadAll, 150);
}

async function loadAll() {
  try {
    const [profiles, lists, tasks] = await Promise.all([
      sb.from('profiles').select('id, display_name').order('display_name'),
      sb.from('lists').select('*').order('position').order('id'),
      sb.from('tasks').select('*').order('created_at'),
    ]);
    for (const res of [profiles, lists, tasks]) if (res.error) throw res.error;

    state.profiles = profiles.data;
    state.lists = lists.data;
    state.tasks = tasks.data;

    if (!state.lists.some((l) => l.id === state.activeListId)) {
      state.activeListId = state.lists[0]?.id ?? null;
    }
    render();
  } catch (err) {
    showError(err);
  }
}

/** Führt eine Datenbank-Aktion aus, zeigt Fehler an und lädt danach neu. */
async function mutate(promise) {
  const { error } = await promise;
  if (error) showError(error);
  scheduleReload();
  return !error;
}

// ---------------------------------------------------------------------
// Ereignisse der Hauptansicht
// ---------------------------------------------------------------------
function setupAppEvents() {
  $('#logout').addEventListener('click', () => sb.auth.signOut());

  $('#new-list-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.name;
    const name = input.value.trim();
    if (!name) return;
    const position = Math.max(0, ...state.lists.map((l) => l.position)) + 1;
    const { data, error } = await sb.from('lists').insert({ name, position }).select().single();
    if (error) return showError(error);
    input.value = '';
    selectList(data.id);
    scheduleReload();
  });

  $('#rename-list').addEventListener('click', async () => {
    const list = activeList();
    const name = prompt('Neuer Name der Liste:', list.name)?.trim();
    if (name && name !== list.name) await mutate(sb.from('lists').update({ name }).eq('id', list.id));
  });

  $('#delete-list').addEventListener('click', async () => {
    const list = activeList();
    const count = state.tasks.filter((t) => t.list_id === list.id).length;
    if (confirm(`Liste „${list.name}“ mit ${count} Aufgabe(n) wirklich löschen?`)) {
      await mutate(sb.from('lists').delete().eq('id', list.id));
    }
  });

  $('#new-task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const title = form.title.value.trim();
    if (!title || !state.activeListId) return;
    const ok = await mutate(sb.from('tasks').insert({
      list_id: state.activeListId,
      title,
      assigned_to: form.assigned_to.value || null,
    }));
    if (ok) form.title.value = '';
    form.title.focus();
  });

  $('#show-done').addEventListener('change', (e) => {
    state.showDone = e.target.checked;
    storage.set('showDone', String(state.showDone));
    renderTasks();
  });

  $('#filter-assignee').addEventListener('change', (e) => {
    state.filterAssignee = e.target.value;
    storage.set('filterAssignee', state.filterAssignee);
    renderTasks();
  });
}

function activeList() {
  return state.lists.find((l) => l.id === state.activeListId);
}

function selectList(id) {
  state.activeListId = id;
  state.editing = null;
  storage.set('activeListId', String(id));
  render();
}

function profileName(id) {
  return state.profiles.find((p) => p.id === id)?.display_name ?? '?';
}

/** Optionen für die "Zuweisen an"-Auswahl. */
function assigneeOptions(selected) {
  return [
    el('option', { value: '', selected: !selected }, '— niemand —'),
    ...state.profiles.map((p) =>
      el('option', { value: p.id, selected: p.id === selected },
        p.id === state.user.id ? `${p.display_name} (ich)` : p.display_name)),
  ];
}

// ---------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------
function render() {
  $('#me').textContent = profileName(state.user.id);
  renderLists();

  const list = activeList();
  $('#no-list').hidden = !!list;
  $('#list-panel').hidden = !list;
  if (!list) return;

  $('#list-title').textContent = list.name;

  // Auswahl im Formular "Neue Aufgabe" aktualisieren, aktuellen Wert behalten
  const select = $('#new-task-assignee');
  const current = select.value;
  select.replaceChildren(...assigneeOptions(current));

  renderTasks();
}

function renderLists() {
  const items = state.lists.map((list) => {
    const open = state.tasks.filter((t) => t.list_id === list.id && !t.done).length;
    return el('li', {},
      el('button', {
        class: list.id === state.activeListId ? 'active' : '',
        onclick: () => selectList(list.id),
      },
      el('span', {}, list.name),
      open ? el('span', { class: 'badge', title: 'offene Aufgaben' }, String(open)) : null));
  });
  $('#lists').replaceChildren(...items);
}

function renderTasks() {
  let tasks = state.tasks.filter((t) => t.list_id === state.activeListId);
  if (!state.showDone) tasks = tasks.filter((t) => !t.done);
  if (state.filterAssignee === 'me') tasks = tasks.filter((t) => t.assigned_to === state.user.id);
  if (state.filterAssignee === 'none') tasks = tasks.filter((t) => !t.assigned_to);

  // Offene zuerst (älteste oben), danach erledigte (zuletzt erledigte oben)
  tasks.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return (b.done_at ?? '').localeCompare(a.done_at ?? '');
    return a.created_at.localeCompare(b.created_at);
  });

  $('#tasks').replaceChildren(...tasks.map(renderTask));
  $('#no-tasks').hidden = tasks.length > 0;
}

function renderTask(task) {
  if (state.editing?.id === task.id) return renderTaskEditor(task);

  const startEdit = () => {
    state.editing = { id: task.id, title: task.title, note: task.note ?? '' };
    renderTasks();
    $('#tasks .task-edit input')?.focus();
  };

  return el('li', { class: 'task' + (task.done ? ' done' : '') },
    el('div', { class: 'task-row' },
      el('input', {
        type: 'checkbox',
        checked: task.done,
        'aria-label': 'erledigt',
        onchange: (e) => mutate(sb.from('tasks')
          .update({ done: e.target.checked, done_at: e.target.checked ? new Date().toISOString() : null })
          .eq('id', task.id)),
      }),
      el('span', { class: 'task-title', title: 'Zum Bearbeiten klicken', onclick: startEdit }, task.title),
      el('select', {
        'aria-label': 'Zuweisen an',
        onchange: (e) => mutate(sb.from('tasks').update({ assigned_to: e.target.value || null }).eq('id', task.id)),
      }, assigneeOptions(task.assigned_to)),
      el('button', { class: 'ghost small', onclick: startEdit }, 'Bearbeiten'),
      el('button', {
        class: 'ghost small danger',
        'aria-label': 'Löschen',
        onclick: () => confirm(`„${task.title}“ löschen?`) && mutate(sb.from('tasks').delete().eq('id', task.id)),
      }, '✕')),
    task.note ? el('div', { class: 'task-note' }, task.note) : null);
}

function renderTaskEditor(task) {
  const draft = state.editing;
  const cancel = () => { state.editing = null; renderTasks(); };
  const save = async (e) => {
    e.preventDefault();
    const title = draft.title.trim();
    if (!title) return;
    state.editing = null;
    await mutate(sb.from('tasks').update({ title, note: draft.note.trim() || null }).eq('id', task.id));
  };

  return el('li', { class: 'task' },
    el('form', { class: 'task-edit', onsubmit: save, onkeydown: (e) => e.key === 'Escape' && cancel() },
      el('input', {
        value: draft.title, maxlength: '300', required: true,
        oninput: (e) => (draft.title = e.target.value),
      }),
      el('textarea', {
        placeholder: 'Notiz (optional)',
        value: draft.note,
        oninput: (e) => (draft.note = e.target.value),
      }),
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'ghost', onclick: cancel }, 'Abbrechen'),
        el('button', { type: 'submit', class: 'primary' }, 'Speichern'))));
}

main();

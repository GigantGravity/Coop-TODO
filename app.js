import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import Sortable from 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/modular/sortable.esm.js';
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

/** Position zwischen zwei Nachbarn (für Drag & Drop): nur der verschobene Eintrag ändert sich. */
function positionBetween(before, after) {
  if (before != null && after != null) return (before + after) / 2;
  if (before != null) return before + 1;
  if (after != null) return after - 1;
  return 0;
}

const nextPosition = (items) => Math.max(0, ...items.map((i) => i.position)) + 1;
const byPosition = (a, b) => a.position - b.position || a.id - b.id;

const PRIORITIES = [
  { value: 2, label: 'Hoch' },
  { value: 1, label: 'Normal' },
  { value: 0, label: 'Niedrig' },
];

// ---------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------
const state = {
  user: null,
  profiles: [],
  lists: [],
  tasks: [],
  subtasks: [],
  activeListId: Number(storage.get('activeListId')) || null,
  showDone: storage.get('showDone') !== 'false',
  filterAssignee: storage.get('filterAssignee') || 'all',
  editing: null,         // { id, title, note, priority } – Aufgabe, die gerade bearbeitet wird
  expanded: new Set(),   // Aufgaben, deren Unteraufgaben aufgeklappt sind
  dragging: false,       // während eines Drag & Drop wird nicht neu gezeichnet
  renderPending: false,
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
  setupDragAndDrop();

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
  Object.assign(state, { profiles: [], lists: [], tasks: [], subtasks: [], editing: null });
  state.expanded.clear();
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
    const [profiles, lists, tasks, subtasks] = await Promise.all([
      sb.from('profiles').select('id, display_name').order('display_name'),
      sb.from('lists').select('*'),
      sb.from('tasks').select('*'),
      sb.from('subtasks').select('*'),
    ]);
    for (const res of [profiles, lists, tasks, subtasks]) if (res.error) throw res.error;

    state.profiles = profiles.data;
    state.lists = lists.data.sort(byPosition);
    state.tasks = tasks.data;
    state.subtasks = subtasks.data.sort(byPosition);

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
    const { data, error } = await sb.from('lists')
      .insert({ name, position: nextPosition(state.lists) })
      .select().single();
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
      priority: Number(form.priority.value),
      position: nextPosition(state.tasks.filter((t) => t.list_id === state.activeListId)),
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

// ---------------------------------------------------------------------
// Drag & Drop
// ---------------------------------------------------------------------
function setupDragAndDrop() {
  const common = {
    animation: 150,
    handle: '.drag-handle',
    forceFallback: true, // gleiches Verhalten mit Maus und Touch
    fallbackOnBody: true,
    onStart: () => { state.dragging = true; },
  };

  const finishDrag = () => {
    state.dragging = false;
    if (state.renderPending) render();
  };

  // Listen in der Seitenleiste
  Sortable.create($('#lists'), {
    ...common,
    onEnd: (evt) => {
      const li = evt.item;
      const list = state.lists.find((l) => l.id === Number(li.dataset.id));
      const before = state.lists.find((l) => l.id === Number(li.previousElementSibling?.dataset.id));
      const after = state.lists.find((l) => l.id === Number(li.nextElementSibling?.dataset.id));
      finishDrag();
      if (evt.oldIndex === evt.newIndex || !list) return;
      list.position = positionBetween(before?.position, after?.position);
      state.lists.sort(byPosition);
      render();
      mutate(sb.from('lists').update({ position: list.position }).eq('id', list.id));
    },
  });

  // Offene Aufgaben – die Überschrift, unter der eine Aufgabe landet, bestimmt ihre Priorität
  Sortable.create($('#tasks'), {
    ...common,
    draggable: 'li',
    filter: '.group-header',
    preventOnFilter: false,
    onStart: () => { state.dragging = true; $('#tasks').classList.add('dragging'); },
    onMove: (evt) => !(evt.related.classList.contains('group-header') && evt.related === evt.to.firstElementChild && !evt.willInsertAfter),
    onEnd: (evt) => {
      $('#tasks').classList.remove('dragging');
      const li = evt.item;
      const task = state.tasks.find((t) => t.id === Number(li.dataset.id));

      let header = li.previousElementSibling;
      while (header && !header.classList.contains('group-header')) header = header.previousElementSibling;
      const priority = header ? Number(header.dataset.priority) : 2;

      const neighbour = (node) => (node?.classList.contains('task') ? state.tasks.find((t) => t.id === Number(node.dataset.id)) : null);
      const before = neighbour(li.previousElementSibling);
      const after = neighbour(li.nextElementSibling);

      finishDrag();
      if (!task || (evt.oldIndex === evt.newIndex)) return;
      task.priority = priority;
      task.position = positionBetween(before?.position, after?.position);
      render();
      mutate(sb.from('tasks').update({ priority: task.priority, position: task.position }).eq('id', task.id));
    },
  });
}

// ---------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------
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

function priorityOptions(selected) {
  return PRIORITIES.map((p) => el('option', { value: String(p.value), selected: p.value === selected }, p.label));
}

/**
 * Zeichnet einen Bereich neu und behält dabei das Eingabefeld mit Fokus (samt Text) bei,
 * damit Live-Updates des anderen Spielers nicht mitten ins Tippen funken.
 */
function preservingFocus(fn) {
  const active = document.activeElement;
  const key = active?.dataset?.focusKey;
  const value = active?.value;
  const selection = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  fn();
  if (!key) return;
  const node = document.querySelector(`[data-focus-key="${key}"]`);
  if (!node || node === active) return;
  if (value != null) node.value = value;
  node.focus();
  if (selection) { try { node.setSelectionRange(...selection); } catch { /* egal */ } }
}

function render() {
  if (state.dragging) { state.renderPending = true; return; }
  state.renderPending = false;

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
    return el('li', { 'data-id': String(list.id) },
      el('span', { class: 'drag-handle', title: 'Ziehen zum Sortieren', 'aria-hidden': 'true' }, '⠿'),
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
  if (state.dragging) { state.renderPending = true; return; }

  let tasks = state.tasks.filter((t) => t.list_id === state.activeListId);
  if (state.filterAssignee === 'me') tasks = tasks.filter((t) => t.assigned_to === state.user.id);
  if (state.filterAssignee === 'none') tasks = tasks.filter((t) => !t.assigned_to);

  const open = tasks.filter((t) => !t.done);
  const done = state.showDone
    ? tasks.filter((t) => t.done).sort((a, b) => (b.done_at ?? '').localeCompare(a.done_at ?? ''))
    : [];

  // Offene Aufgaben nach Priorität gruppiert; Überschriften nur, wenn mehr als eine Gruppe belegt ist
  // (beim Ziehen werden alle Gruppen eingeblendet, damit man auch in leere ziehen kann).
  const groups = PRIORITIES.map((p) => ({ ...p, tasks: open.filter((t) => t.priority === p.value).sort(byPosition) }));
  const showHeaders = groups.filter((g) => g.tasks.length).length > 1;

  const openItems = open.length === 0 ? [] : groups.flatMap((g) => [
    el('li', {
      class: `group-header prio-${g.value}` + (showHeaders && g.tasks.length ? '' : ' collapsed'),
      'data-priority': String(g.value),
    }, g.label, el('span', { class: 'muted' }, ` · ${g.tasks.length}`)),
    ...g.tasks.map(renderTask),
  ]);

  preservingFocus(() => {
    $('#tasks').replaceChildren(...openItems);
    $('#done-tasks').replaceChildren(...done.map(renderTask));
  });
  $('#done-header').hidden = done.length === 0;
  $('#done-header').textContent = `Erledigt · ${done.length}`;
  $('#no-tasks').hidden = open.length + done.length > 0;
}

function renderTask(task) {
  if (state.editing?.id === task.id) return renderTaskEditor(task);

  const subtasks = state.subtasks.filter((s) => s.task_id === task.id);
  const subDone = subtasks.filter((s) => s.done).length;
  const expanded = state.expanded.has(task.id);

  const startEdit = () => {
    state.editing = { id: task.id, title: task.title, note: task.note ?? '', priority: task.priority };
    renderTasks();
    $('#tasks .task-edit input, #done-tasks .task-edit input')?.focus();
  };

  const toggleExpanded = () => {
    if (expanded) state.expanded.delete(task.id);
    else state.expanded.add(task.id);
    renderTasks();
    if (!expanded) document.querySelector(`[data-focus-key="sub-${task.id}"]`)?.focus();
  };

  return el('li', { class: `task prio-${task.priority}` + (task.done ? ' done' : ' open'), 'data-id': String(task.id) },
    el('div', { class: 'task-row' },
      task.done ? null : el('span', { class: 'drag-handle', title: 'Ziehen zum Sortieren', 'aria-hidden': 'true' }, '⠿'),
      el('input', {
        type: 'checkbox',
        checked: task.done,
        'aria-label': 'erledigt',
        onchange: (e) => mutate(sb.from('tasks')
          .update({ done: e.target.checked, done_at: e.target.checked ? new Date().toISOString() : null })
          .eq('id', task.id)),
      }),
      el('span', { class: 'task-title', title: 'Zum Bearbeiten klicken', onclick: startEdit }, task.title),
      el('button', {
        class: 'ghost small sub-toggle' + (subtasks.length ? '' : ' none') + (subtasks.length && subDone === subtasks.length ? ' complete' : ''),
        title: expanded ? 'Unteraufgaben zuklappen' : 'Unteraufgaben anzeigen',
        'aria-expanded': String(expanded),
        onclick: toggleExpanded,
      }, subtasks.length ? `☑ ${subDone}/${subtasks.length}` : '+ Unterpunkte'),
      el('select', {
        'aria-label': 'Zuweisen an',
        onchange: (e) => mutate(sb.from('tasks').update({ assigned_to: e.target.value || null }).eq('id', task.id)),
      }, assigneeOptions(task.assigned_to)),
      el('button', { class: 'ghost small edit-btn', onclick: startEdit }, 'Bearbeiten'),
      el('button', {
        class: 'ghost small danger',
        'aria-label': 'Löschen',
        onclick: () => confirm(`„${task.title}“ löschen?`) && mutate(sb.from('tasks').delete().eq('id', task.id)),
      }, '✕')),
    task.note ? el('div', { class: 'task-note' }, task.note) : null,
    expanded ? renderSubtasks(task, subtasks) : null);
}

function renderSubtasks(task, subtasks) {
  const add = async (e) => {
    e.preventDefault();
    const input = e.target.title;
    const title = input.value.trim();
    if (!title) return;
    input.value = '';
    await mutate(sb.from('subtasks').insert({ task_id: task.id, title, position: nextPosition(subtasks) }));
  };

  return el('div', { class: 'subtasks' },
    el('ul', {}, subtasks.map((sub) =>
      el('li', { class: sub.done ? 'done' : '' },
        el('input', {
          type: 'checkbox',
          checked: sub.done,
          'aria-label': 'erledigt',
          onchange: (e) => mutate(sb.from('subtasks').update({ done: e.target.checked }).eq('id', sub.id)),
        }),
        el('span', {
          class: 'sub-title',
          title: 'Zum Umbenennen klicken',
          onclick: () => {
            const title = prompt('Unterpunkt umbenennen:', sub.title)?.trim();
            if (title && title !== sub.title) mutate(sb.from('subtasks').update({ title }).eq('id', sub.id));
          },
        }, sub.title),
        el('button', {
          class: 'ghost small danger',
          'aria-label': 'Unterpunkt löschen',
          onclick: () => mutate(sb.from('subtasks').delete().eq('id', sub.id)),
        }, '✕')))),
    el('form', { class: 'inline-form', onsubmit: add },
      el('input', { name: 'title', placeholder: 'Unterpunkt hinzufügen …', maxlength: '300', 'data-focus-key': `sub-${task.id}` }),
      el('button', { type: 'submit', 'aria-label': 'Unterpunkt hinzufügen' }, '+')));
}

function renderTaskEditor(task) {
  const draft = state.editing;
  const cancel = () => { state.editing = null; renderTasks(); };
  const save = async (e) => {
    e.preventDefault();
    const title = draft.title.trim();
    if (!title) return;
    const changes = { title, note: draft.note.trim() || null, priority: draft.priority };
    if (changes.priority !== task.priority) {
      // In der neuen Gruppe ans Ende stellen
      changes.position = nextPosition(state.tasks.filter((t) => t.list_id === task.list_id && t.priority === changes.priority));
    }
    state.editing = null;
    await mutate(sb.from('tasks').update(changes).eq('id', task.id));
  };

  return el('li', { class: 'task', 'data-id': String(task.id) },
    el('form', { class: 'task-edit', onsubmit: save, onkeydown: (e) => e.key === 'Escape' && cancel() },
      el('input', {
        value: draft.title, maxlength: '300', required: true, 'data-focus-key': 'edit-title',
        oninput: (e) => (draft.title = e.target.value),
      }),
      el('textarea', {
        placeholder: 'Notiz (optional)',
        value: draft.note,
        'data-focus-key': 'edit-note',
        oninput: (e) => (draft.note = e.target.value),
      }),
      el('div', { class: 'actions' },
        el('label', { class: 'muted' }, 'Priorität ',
          el('select', { onchange: (e) => (draft.priority = Number(e.target.value)) }, priorityOptions(draft.priority))),
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'ghost', onclick: cancel }, 'Abbrechen'),
        el('button', { type: 'submit', class: 'primary' }, 'Speichern'))));
}

main();

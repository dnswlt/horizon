import {
    escapeHTML,
    extractDescLinks,
    formatLinkLabel,
    linkifyHTML,
    getLocalDateString,
    formatShortDate,
    nextWeekdayDateString,
    nextMonthDateString,
    formatTimestamp,
    formatDoneDate,
    formatWaitingSince,
    archiveBucket,
    parseSearchQuery,
    extractContexts,
    groupByContext,
    deriveTaskState,
} from './core.js?v=54';

// App State
let tasks = [];
let workdays = [];
let showCompleted = localStorage.getItem('showCompleted') === 'true';

// DOM Elements
const headerTitle = document.getElementById('header-title');
const weekColumnsContainer = document.getElementById('week-columns');
const backlogTasksContainer = document.getElementById('backlog-tasks-container');
const backlogDropzone = document.getElementById('backlog-dropzone');
const backlogCounter = document.getElementById('backlog-counter');
const backlogEmptyMsg = document.getElementById('backlog-empty-msg');
const snoozedStrip = document.getElementById('snoozed-strip');
const snoozedStripHeader = document.getElementById('snoozed-strip-header');
const snoozedList = document.getElementById('snoozed-list');
const snoozedCounter = document.getElementById('snoozed-counter');
const waitingStrip = document.getElementById('waiting-strip');
const waitingStripHeader = document.getElementById('waiting-strip-header');
const waitingList = document.getElementById('waiting-list');
const waitingCounter = document.getElementById('waiting-counter');
const taskModal = document.getElementById('task-modal');
const taskForm = document.getElementById('task-form');
const modalTitle = document.getElementById('modal-title');
const taskIdField = document.getElementById('task-id-field');
const taskTitleInput = document.getElementById('task-title');
const taskDescInput = document.getElementById('task-description');
const descLinks = document.getElementById('desc-links');
const taskDateSelect = document.getElementById('task-date');
const addBtn = document.getElementById('add-task-btn');
const modalCloseBtn = document.getElementById('modal-close-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const updatesTimeline = document.getElementById('updates-timeline');
const updatesCount = document.getElementById('updates-count');
const newUpdateInput = document.getElementById('new-update-input');
const postUpdateBtn = document.getElementById('post-update-btn');
const shortcutsModal = document.getElementById('shortcuts-modal');
const shortcutsList = document.getElementById('shortcuts-list');
const shortcutsCloseBtn = document.getElementById('shortcuts-close-btn');
const toastContainer = document.getElementById('toast-container');

// Tab Elements
const tabPlanner = document.getElementById('tab-planner');
const tabArchive = document.getElementById('tab-archive');
const viewPlanner = document.getElementById('view-planner');
const viewArchive = document.getElementById('view-archive');
const archiveItemsContainer = document.getElementById('archive-items-container');
const archiveEmptyMsg = document.getElementById('archive-empty-msg');
const archiveSummary = document.getElementById('archive-summary');
const deletedItemsContainer = document.getElementById('deleted-items-container');
const deletedEmptyMsg = document.getElementById('deleted-empty-msg');
const deletedSection = document.querySelector('.deleted-section');
const deletedToggle = document.getElementById('deleted-toggle');
const deletedListContainer = document.getElementById('deleted-list-container');
const toggleCompletedBtn = document.getElementById('toggle-completed-btn');

// Contexts Elements
const tabContexts = document.getElementById('tab-contexts');
const viewContexts = document.getElementById('view-contexts');
const contextsGrid = document.getElementById('contexts-grid');
const contextsEmptyMsg = document.getElementById('contexts-empty-msg');

// Search Elements
const tabSearch = document.getElementById('tab-search');
const viewSearch = document.getElementById('view-search');
const searchInput = document.getElementById('search-input');
const searchIncludeDoneBtn = document.getElementById('search-include-done-btn');
const searchItemsContainer = document.getElementById('search-items-container');
const searchEmptyMsg = document.getElementById('search-empty-msg');

// Pagination state
let archiveOffset = 0;
// Bucket key of the last archive group header rendered, so "Load More" pages
// continue an open group instead of repeating its header.
let archiveLastBucketKey = null;
let deletedOffset = 0;
const PAGE_SIZE = 50;

// Soft WIP limits: a day with more open tasks than these gets its count badge
// tinted — amber past the first, red past the second (the board never hides
// cards; this is purely a "you're taking on a lot" signal).
const DAY_LOAD_WARN = 5;
const DAY_LOAD_HIGH = 7;

// Search state
let searchIncludeDone = true;
let searchTimer = null;

// Contexts state: maps each palette color to a context keyword (e.g.
// { red: 'urgent', blue: 'work', ... }). A task is painted a color when its
// text mentions the matching @keyword. Overwritten by server on load.
let contexts = {
    red: 'urgent',
    green: 'review',
    blue: 'work',
    yellow: '',  // "waiting" retired: it's a real state now (the Waiting list)
    purple: 'home'
};
// Reverse lookup keyword(lowercased) -> color, rebuilt whenever contexts change.
let contextColorMap = {};

function rebuildContextColorMap() {
    contextColorMap = {};
    for (const [color, keyword] of Object.entries(contexts)) {
        const key = (keyword || '').trim().toLowerCase();
        if (key) contextColorMap[key] = color;
    }
}

// Derive a task's color from the first configured @context token in its title
// or description. Reuses extractContexts() so tag parsing lives in one place.
// Returns a color name or null.
function deriveColor(task) {
    for (const tag of extractContexts(task)) {
        const color = contextColorMap[tag];
        if (color) return color;
    }
    return null;
}

// ===== API helper =====

// One place for the JSON-request contract: sets the Content-Type + serialises
// the body when one is given, throws a friendly Error on a non-OK response, and
// returns the parsed JSON (or null for empty bodies, e.g. DELETE). Callers keep
// their own try/catch and success handling.
async function apiFetch(url, { method = 'GET', body, errorMessage } = {}) {
    const opts = { method };
    if (body !== undefined) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(errorMessage || `Request failed (${res.status})`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

// Sugar for the intent endpoints (complete/snooze/wait/restore): POST one
// state change for a task. `body` may be undefined for body-less actions.
const postTaskAction = (id, action, body, errorMessage) =>
    apiFetch(`/api/tasks/${id}/${action}`, { method: 'POST', body, errorMessage });

// Content edits (title/description/due_date). The server expects the full
// set every time; due_date: null moves the task to the backlog.
const editTaskContent = (id, fields, errorMessage) =>
    apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body: fields, errorMessage });

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    calculateWorkdays();
    renderColumnsStructure();
    renderQuickDateButtons();
    rebuildContextColorMap();

    // Set up toggle initial state
    if (showCompleted) {
        toggleCompletedBtn.classList.add('active');
    }

    fetchContexts();
    fetchTasks();
    fetchVersion();
    setupEventListeners();
});

// Show the build (version + commit) at the bottom of the hamburger menu, so
// a user can tell us exactly which build they're running.
async function fetchVersion() {
    try {
        const v = await apiFetch('/api/version');
        document.getElementById('app-version').textContent = `v${v.version} · ${v.commit}`;
    } catch (err) {
        // Purely informational; leave the footer empty on failure.
        console.error(err);
    }
}

// Load context configuration from the server and reflect it in the UI
async function fetchContexts() {
    try {
        contexts = await apiFetch('/api/settings/contexts', { errorMessage: 'Failed to load contexts' });
        rebuildContextColorMap();
        applyContextsToInputs();
        renderTasks();
    } catch (err) {
        // Fall back silently to defaults; not worth a toast on load.
        console.error(err);
    }
}

// Sync the settings dropdown inputs with the current contexts
function applyContextsToInputs() {
    document.querySelectorAll('.context-input').forEach(input => {
        const color = input.getAttribute('data-color');
        if (color && contexts[color] !== undefined) {
            input.value = contexts[color];
        }
    });
}

// Persist contexts to the server (debounced)
let contextsSaveTimer = null;
function saveContexts() {
    clearTimeout(contextsSaveTimer);
    contextsSaveTimer = setTimeout(async () => {
        try {
            await apiFetch('/api/settings/contexts', {
                method: 'PUT', body: contexts, errorMessage: 'Failed to save contexts'
            });
        } catch (err) {
            showToast(err.message, 'error');
        }
    }, 500);
}

// Calculate the upcoming 5 work days starting from today
function calculateWorkdays() {
    workdays = [];
    const today = new Date();
    let current = new Date(today);

    while (workdays.length < 5) {
        const dayOfWeek = current.getDay(); // 0 = Sunday, 6 = Saturday
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            const year = current.getFullYear();
            const month = String(current.getMonth() + 1).padStart(2, '0');
            const day = String(current.getDate()).padStart(2, '0');
            const dateString = `${year}-${month}-${day}`;
            
            // Format labels (short form: Mon, Tue, etc.)
            let label = current.toLocaleDateString('en-US', { weekday: 'short' });
            
            // Special relative label for today
            const diffTime = current.setHours(0,0,0,0) - new Date().setHours(0,0,0,0);
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays === 0) {
                label = 'Today';
            }

            const subtext = current.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            
            workdays.push({
                dateString,
                label,
                subtext
            });
        }
        // Advance 1 day
        current.setDate(current.getDate() + 1);
    }
}

// Render the 5 column structures
function renderColumnsStructure() {
    weekColumnsContainer.innerHTML = '';
    workdays.forEach(day => {
        const col = document.createElement('div');
        col.className = 'planner-column';
        col.id = `col-${day.dateString}`;
        col.innerHTML = `
            <div class="column-header">
                <div class="column-title-row">
                    <div class="column-label">
                        <span class="column-day">${day.label}</span>
                        <span class="column-date">${day.subtext}</span>
                    </div>
                    <span class="column-task-count" id="count-${day.dateString}">0</span>
                </div>
            </div>
            <div class="column-cards" data-date="${day.dateString}"></div>
        `;
        weekColumnsContainer.appendChild(col);
    });
}


// API: Fetch tasks from backend
async function fetchTasks() {
    try {
        tasks = await apiFetch('/api/tasks', { errorMessage: 'Failed to load tasks' });
        renderTasks();
        fetchSnoozedTasks();
        fetchWaitingTasks();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Render tasks into their respective lists
function renderTasks() {
    // Clear all column containers
    const containers = document.querySelectorAll('.column-cards');
    containers.forEach(c => c.innerHTML = '');
    backlogTasksContainer.innerHTML = '';

    // Create a map to store tasks grouped by date
    const grouped = {};
    workdays.forEach(d => grouped[d.dateString] = []);
    grouped['backlog'] = [];

    // Categorize tasks (including overdue ones into today's column)
    const todayDateString = workdays[0].dateString;
    const filteredTasks = showCompleted ? tasks : tasks.filter(t => !t.completed);
    filteredTasks.forEach(task => {
        if (task.completed) {
            // Completed tasks: only show on the board if they match one of the 5 workdays
            if (task.due_date && grouped[task.due_date]) {
                grouped[task.due_date].push(task);
            }
            return;
        }

        // Active tasks categorization
        if (task.due_date) {
            if (grouped[task.due_date]) {
                grouped[task.due_date].push(task);
            } else if (task.due_date < todayDateString) {
                grouped[todayDateString].push(task);
            } else {
                grouped['backlog'].push(task);
            }
        } else {
            grouped['backlog'].push(task);
        }
    });

    // Render columns
    workdays.forEach(day => {
        const list = grouped[day.dateString];
        const container = document.querySelector(`.column-cards[data-date="${day.dateString}"]`);
        const countBadge = document.getElementById(`count-${day.dateString}`);
        
        countBadge.textContent = list.length;
        // Overload is about what's still on the plate, so completed tasks
        // (shown or not) don't count against the limit.
        const openCount = list.filter(t => !t.completed).length;
        countBadge.classList.toggle('overloaded', openCount > DAY_LOAD_HIGH);
        countBadge.classList.toggle('busy', openCount > DAY_LOAD_WARN && openCount <= DAY_LOAD_HIGH);

        list.sort((a, b) => a.position - b.position);
        list.forEach(task => {
            container.appendChild(createCardElement(task));
        });
    });

    // Render Backlog
    const backlogList = grouped['backlog'];
    backlogCounter.textContent = backlogList.length;
    
    backlogTasksContainer.style.display = 'flex';
    if (backlogList.length === 0) {
        backlogEmptyMsg.style.display = 'flex';
    } else {
        backlogEmptyMsg.style.display = 'none';
        
        backlogList.sort((a, b) => a.position - b.position);
        backlogList.forEach(task => {
            backlogTasksContainer.appendChild(createCardElement(task));
        });
    }

    setupDragAndDrop();
}

// Reusable inline SVG icons for the small action buttons. Kept as complete
// <svg> strings so one definition keeps every button pixel-identical wherever
// it appears (task cards, search results, archive rows).
const ICON_ATTRS = 'viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
    edit: `<svg ${ICON_ATTRS}>
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
        <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
    </svg>`,
    trash: `<svg ${ICON_ATTRS}>
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
    </svg>`,
    reopen: `<svg ${ICON_ATTRS}>
        <path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"></path>
        <polyline points="8 8 12 4 16 8"></polyline>
        <line x1="12" y1="4" x2="12" y2="16"></line>
    </svg>`,
    check: `<svg ${ICON_ATTRS}>
        <polyline points="20 6 9 17 4 12"></polyline>
    </svg>`,
};

// DOM Helper: Create task card element
function createCardElement(task) {
    const card = document.createElement('div');
    const cardColor = deriveColor(task);
    card.className = `task-card ${task.completed ? 'completed' : ''} ${cardColor ? 'color-' + cardColor : ''}`;
    card.draggable = true;
    card.dataset.id = task.id;
    
    // Truncate description for display
    const descText = task.description || '';
    const descHtml = descText ? `<div class="card-desc">${escapeHTML(descText)}</div>` : '';
    
    // Due date label (show "Overdue", specific date, or nothing)
    const todayDateString = workdays[0].dateString;
    const isOverdue = task.due_date && task.due_date < todayDateString && !task.completed;
    
    let dateBadge = '';
    if (isOverdue) {
        const d = new Date(task.due_date);
        const dateFormatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        dateBadge = `
            <div class="card-date-badge overdue">
                <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <span>Overdue: ${dateFormatted}</span>
            </div>
        `;
    } else if (task.due_date) {
        // If it's scheduled for a day inside our columns, and not overdue, we omit the badge (column headers represent it)
        const inColumns = workdays.some(w => w.dateString === task.due_date);
        if (!inColumns) {
            const d = new Date(task.due_date);
            const dateFormatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            dateBadge = `
                <div class="card-date-badge">
                    <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="16" y1="2" x2="16" y2="6"></line>
                        <line x1="8" y1="2" x2="8" y2="6"></line>
                        <line x1="3" y1="10" x2="21" y2="10"></line>
                    </svg>
                    <span>${dateFormatted}</span>
                </div>
            `;
        }
    }

    // Resurfaced badge: a snoozed task whose defer_until date has arrived
    const today = getLocalDateString(0);
    const isResurfaced = task.defer_until && task.defer_until <= today && !task.completed;
    const resurfacedBadge = isResurfaced
        ? `<div class="card-resurfaced-badge" title="This task's snooze period ended — it's back on your board">
                <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="9"></circle>
                    <polyline points="12 8 12 12 15 14"></polyline>
                </svg>
                <span>Snooze ended</span>
                <span class="card-resurfaced-dismiss" title="Dismiss">&times;</span>
           </div>`
        : '';

    // Snooze button (active tasks only)
    const snoozeBtn = !task.completed
        ? `<button class="action-btn snooze-btn" title="Snooze">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="9"></circle>
                    <polyline points="12 8 12 12 15 14"></polyline>
                </svg>
           </button>`
        : '';

    card.innerHTML = `
        <div class="card-header">
            <div class="card-title-container">
                <input type="checkbox" class="card-checkbox" ${task.completed ? 'checked' : ''}>
                <span class="card-title">${escapeHTML(task.title)}</span>
                ${dateBadge}
                ${resurfacedBadge}
            </div>
            <div class="card-actions">
                ${snoozeBtn}
                <button class="action-btn edit-btn" title="Edit task">${ICONS.edit}</button>
                <button class="action-btn delete-btn" title="Delete task">${ICONS.trash}</button>
            </div>
        </div>
        ${descHtml}
    `;

    // Event Checkbox Toggle
    const checkbox = card.querySelector('.card-checkbox');
    checkbox.addEventListener('change', async (e) => {
        const completed = e.target.checked;
        await toggleTaskCompletion(task.id, completed, card);
    });

    // Event Edit Button
    const editBtn = card.querySelector('.edit-btn');
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(task);
    });

    // Event Delete Button
    const deleteBtn = card.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        // No confirmation: deletes are soft (recoverable from Archive → Trash)
        await deleteTask(task.id);
    });

    // Snooze button → open preset popover
    const snoozeBtnEl = card.querySelector('.snooze-btn');
    if (snoozeBtnEl) {
        snoozeBtnEl.addEventListener('click', (e) => {
            e.stopPropagation();
            openSnoozePopover(snoozeBtnEl, task);
        });
    }

    // Resurfaced badge dismiss → acknowledge (clear defer_until)
    const dismissEl = card.querySelector('.card-resurfaced-dismiss');
    if (dismissEl) {
        dismissEl.addEventListener('click', async (e) => {
            e.stopPropagation();
            await unsnoozeTask(task.id, false);
        });
    }

    // Double click card to edit
    card.addEventListener('dblclick', (e) => {
        if (e.target.closest('.card-actions') || e.target.closest('.card-checkbox') || e.target.closest('.card-resurfaced-badge')) {
            return;
        }
        openModal(task);
    });

    return card;
}

// Toggle task completion
async function toggleTaskCompletion(id, completed, cardEl) {
    try {
        await postTaskAction(id, 'complete', { completed }, 'Could not update task status');

        // Find local task and update
        const taskIdx = tasks.findIndex(t => t.id === id);
        if (taskIdx > -1) {
            tasks[taskIdx].completed = completed;
        }

        if (completed) {
            cardEl.classList.add('completed');
        } else {
            cardEl.classList.remove('completed');
        }
        
        showToast(completed ? 'Task completed!' : 'Task active.');
    } catch (err) {
        showToast(err.message, 'error');
        // Revert checkbox state
        cardEl.querySelector('.card-checkbox').checked = !completed;
    }
}

// API: Set completion state and refresh views (used by search results, where
// there is no card element to toggle in place)
async function setTaskCompleted(id, completed) {
    try {
        await postTaskAction(id, 'complete', { completed }, 'Could not update task status');

        showToast(completed ? 'Task completed!' : 'Task reopened.');
        await fetchTasks();     // keep the Horizon board in sync
        await performSearch();  // refresh the result's status pill / filtering
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// API: Delete task
async function deleteTask(id) {
    try {
        await apiFetch(`/api/tasks/${id}`, { method: 'DELETE', errorMessage: 'Could not delete task' });

        tasks = tasks.filter(t => t.id !== id);
        renderTasks();
        showToast('Task moved to Trash.');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ===== Snooze / defer =====

let snoozePopoverEl = null;

function closeSnoozePopover() {
    if (snoozePopoverEl) {
        snoozePopoverEl.remove();
        snoozePopoverEl = null;
        document.removeEventListener('click', onSnoozeOutsideClick, true);
    }
}

function onSnoozeOutsideClick(e) {
    if (snoozePopoverEl && !snoozePopoverEl.contains(e.target)) {
        closeSnoozePopover();
    }
}

function openSnoozePopover(anchorEl, task) {
    closeSnoozePopover();

    const presets = [
        { label: 'Tomorrow', date: getLocalDateString(1) },
        { label: 'Next week', date: nextWeekdayDateString(1) },
        { label: 'In 2 weeks', date: getLocalDateString(14) },
        { label: 'Next month', date: nextMonthDateString() },
    ];

    const pop = document.createElement('div');
    pop.className = 'snooze-popover';
    pop.innerHTML = `
        <div class="snooze-popover-title">Snooze until…</div>
        ${presets.map(p => `
            <button type="button" class="snooze-preset" data-date="${p.date}">
                <span>${p.label}</span>
                <span class="snooze-preset-date">${formatShortDate(p.date)}</span>
            </button>`).join('')}
        <label class="snooze-custom">
            <input type="date" class="snooze-custom-input" min="${getLocalDateString(1)}">
        </label>
        <div class="snooze-divider"></div>
        <button type="button" class="snooze-preset snooze-waiting">
            <span>Move to Waiting</span>
            <svg class="snooze-waiting-icon" viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="5 17 10 12 5 7"></polyline>
                <polyline points="11 17 16 12 11 7"></polyline>
                <polyline points="17 17 22 12 17 7"></polyline>
            </svg>
        </button>
    `;
    document.body.appendChild(pop);
    snoozePopoverEl = pop;

    // Position below the anchor, right-aligned, clamped to the viewport
    const rect = anchorEl.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let left = rect.right + window.scrollX - popRect.width;
    if (left < 8) left = 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${rect.bottom + window.scrollY + 6}px`;

    // Only the dated presets snooze; the Waiting button shares .snooze-preset for
    // styling but has no data-date and its own handler below.
    pop.querySelectorAll('.snooze-preset[data-date]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const date = btn.getAttribute('data-date');
            closeSnoozePopover();
            await snoozeTask(task, date);
        });
    });

    const customInput = pop.querySelector('.snooze-custom-input');
    customInput.addEventListener('change', async (e) => {
        e.stopPropagation();
        if (customInput.value) {
            closeSnoozePopover();
            await snoozeTask(task, customInput.value);
        }
    });

    pop.querySelector('.snooze-waiting').addEventListener('click', async (e) => {
        e.stopPropagation();
        closeSnoozePopover();
        await waitTask(task);
    });

    // Bind outside-click on the next tick so the opening click doesn't close it
    setTimeout(() => document.addEventListener('click', onSnoozeOutsideClick, true), 0);
}

async function snoozeTask(task, dateString) {
    try {
        await postTaskAction(task.id, 'snooze', { until: dateString }, 'Failed to snooze task');
        await fetchTasks();
        showToast(`Snoozed until ${formatShortDate(dateString)}.`);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// notify=false is used for the resurfaced-badge dismiss (silent acknowledge)
async function unsnoozeTask(id, notify = true) {
    try {
        await postTaskAction(id, 'snooze', { until: null }, 'Failed to un-snooze task');
        await fetchTasks();
        if (notify) showToast('Task returned to backlog.');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ===== Waiting list ("Waiting For": parked on someone else, no wake date) =====

async function waitTask(task) {
    try {
        await postTaskAction(task.id, 'wait', { waiting: true }, 'Failed to move task to Waiting');
        await fetchTasks();
        showToast('Moved to Waiting.');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function unwaitTask(id) {
    try {
        await postTaskAction(id, 'wait', { waiting: false }, 'Failed to remove task from Waiting');
        await fetchTasks();
        showToast('Task returned to backlog.');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function fetchSnoozedTasks() {
    try {
        renderSnoozedStrip(await apiFetch('/api/tasks/snoozed', { errorMessage: 'Failed to load snoozed tasks' }));
    } catch (err) {
        console.error(err);
    }
}

function renderSnoozedStrip(snoozed) {
    if (!snoozed.length) {
        snoozedStrip.style.display = 'none';
        snoozedList.innerHTML = '';
        return;
    }
    snoozedStrip.style.display = 'block';
    snoozedCounter.textContent = snoozed.length;

    snoozedList.innerHTML = '';
    snoozed.forEach(task => {
        const row = document.createElement('div');
        row.className = 'snoozed-row';
        row.innerHTML = `
            <div class="snoozed-row-info">
                <span class="snoozed-row-title">${escapeHTML(task.title)}</span>
                <span class="snoozed-row-until">until ${formatShortDate(task.defer_until)}</span>
            </div>
            <button type="button" class="btn btn-secondary snoozed-unsnooze-btn" data-id="${task.id}">Un-snooze</button>
        `;
        row.querySelector('.snoozed-unsnooze-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            await unsnoozeTask(task.id);
        });
        snoozedList.appendChild(row);
    });
}

async function fetchWaitingTasks() {
    try {
        renderWaitingStrip(await apiFetch('/api/tasks/waiting', { errorMessage: 'Failed to load waiting tasks' }));
    } catch (err) {
        console.error(err);
    }
}

function renderWaitingStrip(waiting) {
    if (!waiting.length) {
        waitingStrip.style.display = 'none';
        waitingList.innerHTML = '';
        return;
    }
    waitingStrip.style.display = 'block';
    waitingCounter.textContent = waiting.length;

    waitingList.innerHTML = '';
    waiting.forEach(task => {
        const row = document.createElement('div');
        row.className = 'waiting-row';
        // "waiting since today / yesterday / Jul 2"; exact timestamp on hover.
        row.innerHTML = `
            <div class="waiting-row-info">
                <span class="waiting-row-title">${escapeHTML(task.title)}</span>
                <span class="waiting-row-since" title="since ${formatTimestamp(task.waiting_since)}">waiting since ${formatWaitingSince(task.waiting_since)}</span>
            </div>
            <button type="button" class="btn btn-secondary waiting-unwait-btn" data-id="${task.id}">Un-wait</button>
        `;
        row.querySelector('.waiting-unwait-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            await unwaitTask(task.id);
        });
        waitingList.appendChild(row);
    });
}

// Drag and Drop Logic
function setupDragAndDrop() {
    const cards = document.querySelectorAll('.task-card');
    const lists = [
        ...document.querySelectorAll('.column-cards'),
        backlogTasksContainer
    ];
    
    // Highlight drop zones during dragging
    cards.forEach(card => {
        card.addEventListener('dragstart', () => {
            card.classList.add('dragging');
        });

        card.addEventListener('dragend', async () => {
            card.classList.remove('dragging');
            
            // Remove highlight classes from all containers
            lists.forEach(list => {
                const parentZone = getParentDropzone(list);
                if (parentZone) parentZone.classList.remove('drag-over');
            });
            
            // Persist the new layout
            await saveReorderedState();
        });
    });

    lists.forEach(list => {
        const parentZone = getParentDropzone(list);
        
        list.addEventListener('dragover', (e) => {
            e.preventDefault();
            const dragging = document.querySelector('.dragging');
            if (!dragging) return;
            
            const afterElement = getDragAfterElement(list, e.clientY);
            if (afterElement == null) {
                list.appendChild(dragging);
            } else {
                list.insertBefore(dragging, afterElement);
            }
        });

        list.addEventListener('dragenter', (e) => {
            e.preventDefault();
            if (parentZone) parentZone.classList.add('drag-over');
        });

        list.addEventListener('dragleave', (e) => {
            // Check if we are actually leaving the container (and not just crossing nested boundaries)
            const rect = parentZone.getBoundingClientRect();
            const x = e.clientX;
            const y = e.clientY;
            
            if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
                if (parentZone) parentZone.classList.remove('drag-over');
            }
        });
        
        // Also support dropping on parent dropzone if card container is smaller
        if (parentZone && parentZone !== list) {
            parentZone.addEventListener('dragover', (e) => {
                e.preventDefault();
            });
            parentZone.addEventListener('dragenter', (e) => {
                e.preventDefault();
                parentZone.classList.add('drag-over');
            });
            parentZone.addEventListener('drop', (e) => {
                e.preventDefault();
                parentZone.classList.remove('drag-over');
                const dragging = document.querySelector('.dragging');
                // Only append if the drop landed outside the list (e.g. on the
                // empty-state message or padding). If dragover already placed the
                // card inside the list, leave it at its computed position.
                if (dragging && dragging.parentElement !== list) {
                    list.appendChild(dragging);
                }
            });
        }
    });
}

// Helper: Get parent highlight element for drop visual cue
function getParentDropzone(list) {
    if (list.classList.contains('column-cards')) {
        return list.closest('.planner-column');
    } else if (list.id === 'backlog-tasks-container') {
        return backlogDropzone;
    }
    return null;
}

// Calculate which card the cursor is hovering above
function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.task-card:not(.dragging)')];
    
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// API: Send reorder mapping to server after drag drop finish
async function saveReorderedState() {
    const updates = [];
    
    // 1. Scan the 5 Workday Columns
    const columns = document.querySelectorAll('.column-cards');
    columns.forEach(col => {
        const date = col.dataset.date;
        const cards = [...col.children];
        cards.forEach((card, index) => {
            updates.push({
                id: card.dataset.id,
                due_date: date,
                position: index
            });
        });
    });
    
    // 2. Scan the Backlog
    const backlogCards = [...backlogTasksContainer.children];
    backlogCards.forEach((card, index) => {
        const taskId = card.dataset.id;
        const existingTask = tasks.find(t => t.id === taskId);
        let targetDueDate = null;
        
        if (existingTask) {
            // Check if it was previously scheduled in the 5-day horizon
            const wasScheduledInHorizon = existingTask.due_date && workdays.some(w => w.dateString === existingTask.due_date);
            if (!wasScheduledInHorizon) {
                // If it was already in the backlog (either null or a future date), preserve its due date
                targetDueDate = existingTask.due_date;
            }
        }
        
        updates.push({
            id: taskId,
            due_date: targetDueDate,
            position: index
        });
    });

    if (updates.length === 0) return;

    try {
        await apiFetch('/api/tasks/reorder', {
            method: 'POST', body: { tasks: updates }, errorMessage: 'Failed to save layout order'
        });

        // Sync our local model to match DOM, and trigger UI updates
        updates.forEach(upd => {
            const task = tasks.find(t => t.id === upd.id);
            if (task) {
                task.due_date = upd.due_date;
                task.position = upd.position;
            }
        });
        
        // Re-render to update counters, dates labels, etc.
        renderTasks();
    } catch (err) {
        showToast(err.message, 'error');
        // Reload tasks from API to revert to server state
        fetchTasks();
    }
}

// Modal handling
function openModal(task = null) {
    if (task) {
        // Edit mode
        modalTitle.textContent = 'Edit Task';
        taskIdField.value = task.id;
        taskTitleInput.value = task.title;
        taskDescInput.value = task.description || '';

        taskDateSelect.value = task.due_date || '';
        taskModal.classList.add('mode-edit');
        loadTaskUpdates(task.id);
    } else {
        // Add mode
        modalTitle.textContent = 'Create Task';
        taskIdField.value = '';
        taskForm.reset();
        taskDateSelect.value = ''; // Default to backlog
        taskModal.classList.remove('mode-edit');
        newUpdateInput.value = '';
        updatesTimeline.innerHTML = '';
        updatesCount.textContent = '0';
    }

    updateQuickDateActiveHighlight();
    renderDescLinks();
    taskModal.classList.add('active');
    taskTitleInput.focus();
}

function closeModal() {
    taskModal.classList.remove('active');
}

// --- Task updates (the per-task log shown in the edit modal's right rail) ---

async function loadTaskUpdates(taskId) {
    updatesTimeline.innerHTML = '';
    newUpdateInput.value = '';
    try {
        const data = await apiFetch(`/api/tasks/${taskId}/updates`, { errorMessage: 'Failed to load updates' });
        renderUpdates(data.updates);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderUpdates(updates) {
    updatesTimeline.innerHTML = '';
    updates.forEach(u => updatesTimeline.appendChild(createUpdateElement(u)));
    updatesCount.textContent = String(updates.length);
}

function createUpdateElement(update) {
    const isSystem = update.kind === 'system';
    const el = document.createElement('div');
    el.className = 'update-entry' + (isSystem ? ' system' : '');
    el.dataset.id = update.id;

    const meta = document.createElement('div');
    meta.className = 'update-meta';
    const time = document.createElement('span');
    time.textContent = formatTimestamp(update.created_at);
    meta.appendChild(time);
    if (!isSystem) {
        const actions = document.createElement('span');
        actions.className = 'update-actions';
        actions.innerHTML = '<button data-act="edit">edit</button><button data-act="delete">delete</button>';
        meta.appendChild(actions);
    }

    const body = document.createElement('div');
    body.className = 'update-body';
    // linkifyHTML escapes the text and turns bare URLs into clickable links.
    body.innerHTML = linkifyHTML(update.body);

    el.appendChild(meta);
    el.appendChild(body);
    return el;
}

async function postUpdate() {
    const taskId = taskIdField.value;
    const body = newUpdateInput.value.trim();
    if (!taskId || !body) return;
    try {
        const created = await apiFetch(`/api/tasks/${taskId}/updates`, {
            method: 'POST', body: { body }, errorMessage: 'Failed to post update'
        });
        newUpdateInput.value = '';
        updatesTimeline.insertBefore(createUpdateElement(created), updatesTimeline.firstChild);
        updatesCount.textContent = String(updatesTimeline.querySelectorAll('.update-entry').length);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deleteUpdate(id, entry) {
    if (!confirm('Delete this update? This cannot be undone.')) return;
    try {
        await apiFetch(`/api/updates/${id}`, { method: 'DELETE', errorMessage: 'Failed to delete update' });
        entry.remove();
        updatesCount.textContent = String(updatesTimeline.querySelectorAll('.update-entry').length);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Inline-edit an entry in place; original timestamp is preserved server-side.
function startEditUpdate(id, entry) {
    if (entry.querySelector('.update-edit-box')) return; // already editing
    const body = entry.querySelector('.update-body');
    const original = body.textContent;

    const box = document.createElement('textarea');
    box.className = 'update-edit-box';
    box.value = original;
    const actions = document.createElement('div');
    actions.className = 'update-edit-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);

    body.replaceChildren(box, actions);
    box.focus();

    const restore = (text) => { body.innerHTML = linkifyHTML(text); };
    cancelBtn.onclick = () => restore(original);
    saveBtn.onclick = async () => {
        const text = box.value.trim();
        if (!text) { restore(original); return; }
        try {
            const edited = await apiFetch(`/api/updates/${id}`, {
                method: 'PUT', body: { body: text }, errorMessage: 'Failed to save update'
            });
            restore(edited.body);
        } catch (err) {
            showToast(err.message, 'error');
            restore(original);
        }
    };
}

// Quick Date Helpers
function renderQuickDateButtons() {
    const quickDatesContainer = document.querySelector('.quick-dates');
    if (!quickDatesContainer) return;
    
    quickDatesContainer.innerHTML = '';
    
    const todayStr = getLocalDateString(0);
    const tomorrowStr = getLocalDateString(1);
    
    workdays.forEach(day => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-quick-date';
        btn.setAttribute('data-date', day.dateString);
        
        let label = day.label;
        if (day.dateString === todayStr) {
            label = 'Today';
        } else if (day.dateString === tomorrowStr) {
            label = 'Tomorrow';
        }
        
        btn.textContent = label;
        quickDatesContainer.appendChild(btn);
    });
}

function updateQuickDateActiveHighlight() {
    const dateVal = taskDateSelect.value;
    document.querySelectorAll('.btn-quick-date').forEach(btn => {
        if (btn.getAttribute('data-date') === dateVal) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// Save form handler (Add / Edit)
taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // Explicitly validate taskTitleInput since the form has 'novalidate' to bypass Safari's
    // date validation bug (setting date value = '' programmatically leaves the input in an invalid state).
    if (!taskTitleInput.reportValidity()) {
        return;
    }
    
    const id = taskIdField.value;
    const title = taskTitleInput.value.trim();
    const description = taskDescInput.value.trim();
    const dueDate = taskDateSelect.value || null;
    
    if (!title) return;

    // Calculate position
    let position = 0;
    if (!id) {
        // New task: place it at the end of the selected list
        const sameListTasks = tasks.filter(t => {
            if (dueDate) return t.due_date === dueDate;
            // Backlog items have null or out-of-horizon due dates
            const inHorizon = t.due_date && workdays.some(w => w.dateString === t.due_date);
            return !t.due_date || !inHorizon;
        });
        position = sameListTasks.length;
    }

    try {
        if (id) {
            // Edit API call
            await editTaskContent(id, { title, description, due_date: dueDate }, 'Failed to update task');
            showToast('Task updated.');
        } else {
            // Create API call
            await apiFetch('/api/tasks', {
                method: 'POST',
                body: { title, description, due_date: dueDate, position },
                errorMessage: 'Failed to create task'
            });
            showToast('Task created.');
        }
        
        closeModal();
        fetchTasks();
        // Keep the active auxiliary view in sync when editing from it
        if (viewSearch.classList.contains('active')) {
            performSearch();
        } else if (viewArchive.classList.contains('active')) {
            fetchArchivedTasks(true);
        } else if (viewContexts.classList.contains('active')) {
            fetchOpenTasks();
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
});

// Keyboard Shortcuts
// key → { label, run }. The help popup is generated from this registry, so
// adding a shortcut here also documents it. Modal-scoped keys (ESC) live in
// the keydown handler in setupEventListeners, not here.
const SHORTCUTS = {
    'n': { label: 'New task',            run: () => openModal() },
    '/': { label: 'Search',              run: () => switchTab('search') },
    'h': { label: 'Horizon board',       run: () => scrollToBoard() },
    'b': { label: 'Backlog',             run: () => scrollToBacklog() },
    'a': { label: 'Archive',             run: () => switchTab('archive') },
    'c': { label: 'Contexts',            run: () => switchTab('contexts') },
    '?': { label: 'Toggle this help',    run: () => toggleShortcutHelp() },
};

// Switch to the Horizon board and jump back to the top of the page, matching
// the other tabs (e.g. returning from the Backlog).
function scrollToBoard() {
    switchTab('planner');
    window.scrollTo(0, 0);
}

// The Backlog lives at the bottom of the Horizon board, so switch to that tab
// first, then scroll its section into view.
function scrollToBacklog() {
    switchTab('planner');
    document.querySelector('.backlog-section')?.scrollIntoView();
}

// True when the event originated from a text-entry surface, where single-key
// shortcuts must yield to normal typing.
function isEditableTarget(el) {
    return el instanceof HTMLElement &&
        (el.matches('input, textarea, select') || el.isContentEditable);
}

function toggleShortcutHelp(force) {
    const show = typeof force === 'boolean'
        ? force
        : !shortcutsModal.classList.contains('active');
    shortcutsModal.classList.toggle('active', show);
}

function renderShortcutHelp() {
    shortcutsList.innerHTML = Object.entries(SHORTCUTS).map(([key, { label }]) =>
        `<div class="shortcut-row">
            <kbd>${escapeHTML(key)}</kbd>
            <span>${escapeHTML(label)}</span>
        </div>`
    ).join('');
}

// Setup event listeners
function setupEventListeners() {
    addBtn.addEventListener('click', () => openModal());
    modalCloseBtn.addEventListener('click', closeModal);
    modalCancelBtn.addEventListener('click', closeModal);

    // Expand/collapse the snoozed strip
    snoozedStripHeader.addEventListener('click', () => {
        const expanded = snoozedStrip.classList.toggle('expanded');
        snoozedList.style.display = expanded ? 'flex' : 'none';
        snoozedStripHeader.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });

    // Expand/collapse the waiting strip (expanded by default)
    waitingStripHeader.addEventListener('click', () => {
        const expanded = waitingStrip.classList.toggle('expanded');
        waitingList.style.display = expanded ? 'flex' : 'none';
        waitingStripHeader.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });

    // Expand/collapse the Deleted (Trash) section — folded by default, and its
    // contents are fetched lazily the first time (and each time) it is opened.
    deletedToggle.addEventListener('click', () => {
        const expanded = deletedSection.classList.toggle('expanded');
        deletedListContainer.style.display = expanded ? 'flex' : 'none';
        deletedToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (expanded) fetchDeletedTasks(true);
    });

    // Live-update the clickable links strip as the description changes
    taskDescInput.addEventListener('input', renderDescLinks);

    // Ctrl/Cmd+Enter submits the task form from within the description textarea
    taskDescInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            taskForm.requestSubmit();
        }
    });

    // Task updates: post, plus delegated edit/delete on the timeline
    postUpdateBtn.addEventListener('click', postUpdate);
    newUpdateInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            postUpdate();
        }
    });
    updatesTimeline.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const entry = btn.closest('.update-entry');
        if (!entry) return;
        if (btn.dataset.act === 'delete') {
            deleteUpdate(entry.dataset.id, entry);
        } else if (btn.dataset.act === 'edit') {
            startEditUpdate(entry.dataset.id, entry);
        }
    });

    // Clear date button
    const clearDateBtn = document.getElementById('clear-date-btn');
    clearDateBtn.addEventListener('click', () => {
        taskDateSelect.value = '';
        updateQuickDateActiveHighlight();
    });

    // Quick date button selectors (via event delegation)
    const quickDatesContainer = document.querySelector('.quick-dates');
    if (quickDatesContainer) {
        quickDatesContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-quick-date');
            if (!btn) return;
            taskDateSelect.value = btn.getAttribute('data-date') || '';
            updateQuickDateActiveHighlight();
        });
    }

    // Synchronize custom date picker manual input changes
    taskDateSelect.addEventListener('input', updateQuickDateActiveHighlight);

    // Toggle completed state button click
    toggleCompletedBtn.addEventListener('click', () => {
        showCompleted = !showCompleted;
        localStorage.setItem('showCompleted', showCompleted);
        if (showCompleted) {
            toggleCompletedBtn.classList.add('active');
        } else {
            toggleCompletedBtn.classList.remove('active');
        }
        renderTasks();
    });

    // Toggle settings dropdown
    const settingsMenuBtn = document.getElementById('settings-menu-btn');
    const settingsDropdown = document.getElementById('settings-dropdown');
    
    if (settingsMenuBtn && settingsDropdown) {
        settingsMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            settingsDropdown.classList.toggle('active');
        });
        
        settingsDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        
        document.addEventListener('click', (e) => {
            if (!settingsDropdown.contains(e.target) && e.target !== settingsMenuBtn) {
                settingsDropdown.classList.remove('active');
            }
        });
    }

    // Populate and bind context keyword inputs
    document.querySelectorAll('.context-input').forEach(input => {
        const color = input.getAttribute('data-color');
        if (color && contexts[color] !== undefined) {
            input.value = contexts[color];
        }

        input.addEventListener('input', (e) => {
            contexts[color] = e.target.value.trim();
            rebuildContextColorMap();
            saveContexts();
            renderTasks();
        });
    });
    
    // Tab switching
    tabPlanner.addEventListener('click', () => switchTab('planner'));
    tabArchive.addEventListener('click', () => switchTab('archive'));
    tabContexts.addEventListener('click', () => switchTab('contexts'));
    tabSearch.addEventListener('click', () => switchTab('search'));

    // Search
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(performSearch, 250);
    });
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            clearTimeout(searchTimer);
            performSearch();
        }
    });
    searchIncludeDoneBtn.addEventListener('click', () => {
        searchIncludeDone = !searchIncludeDone;
        searchIncludeDoneBtn.classList.toggle('active', searchIncludeDone);
        performSearch();
    });

    // Load more buttons
    document.getElementById('btn-load-more-archive').addEventListener('click', async () => {
        archiveOffset += PAGE_SIZE;
        await fetchArchivedTasks(false);
    });
    document.getElementById('btn-load-more-deleted').addEventListener('click', async () => {
        deletedOffset += PAGE_SIZE;
        await fetchDeletedTasks(false);
    });
    
    // Close modal when clicking on overlay background
    taskModal.addEventListener('click', (e) => {
        if (e.target === taskModal) closeModal();
    });
    
    // Keyboard shortcuts (see the SHORTCUTS registry above)
    renderShortcutHelp();
    shortcutsCloseBtn.addEventListener('click', () => toggleShortcutHelp(false));
    shortcutsModal.addEventListener('click', (e) => {
        if (e.target === shortcutsModal) toggleShortcutHelp(false);
    });
    document.addEventListener('keydown', (e) => {
        // ESC closes whichever overlay is open, otherwise it releases focus from
        // a field (e.g. the search box) so single-key shortcuts work again
        if (e.key === 'Escape') {
            if (taskModal.classList.contains('active')) closeModal();
            else if (shortcutsModal.classList.contains('active')) toggleShortcutHelp(false);
            else if (isEditableTarget(e.target)) e.target.blur();
            return;
        }

        // No shortcuts while typing in a field or with modifier keys held
        if (isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;

        // The task modal is a form — don't fire shortcuts behind it
        if (taskModal.classList.contains('active')) return;

        // While the help popup is open, only "?" (toggle) responds
        if (shortcutsModal.classList.contains('active') && e.key !== '?') return;

        const shortcut = SHORTCUTS[e.key];
        if (shortcut) {
            e.preventDefault();
            shortcut.run();
        }
    });
}

// Tab Switching logic
async function switchTab(tabId) {
    const tabs = { planner: tabPlanner, archive: tabArchive, contexts: tabContexts, search: tabSearch };
    const views = { planner: viewPlanner, archive: viewArchive, contexts: viewContexts, search: viewSearch };
    Object.keys(tabs).forEach(id => {
        tabs[id].classList.toggle('active', id === tabId);
        views[id].classList.toggle('active', id === tabId);
    });

    // The header title doubles as the current view's heading; the views
    // themselves carry no <h2>. The active tab's own label is the source of
    // truth (the planner tab is labelled "Horizon").
    headerTitle.textContent = tabs[tabId].textContent.trim();

    if (tabId === 'archive') {
        await fetchArchivedTasks(true);
        await fetchDeletedTasks(true);
    } else if (tabId === 'contexts') {
        await fetchOpenTasks();
    } else if (tabId === 'search') {
        searchInput.focus();
        performSearch();
    }
}

// Archive Functions
async function fetchArchivedTasks(replace = false) {
    try {
        if (replace) {
            archiveOffset = 0;
        }
        const data = await apiFetch(`/api/tasks/archive?limit=${PAGE_SIZE}&offset=${archiveOffset}`, { errorMessage: 'Failed to load archive' });

        if (replace) renderArchiveSummary(data.tasks, data.has_more);
        renderArchivedTasks(data.tasks, !replace);
        
        const loadMoreContainer = document.getElementById('archive-load-more-container');
        if (data.has_more) {
            loadMoreContainer.style.display = 'flex';
        } else {
            loadMoreContainer.style.display = 'none';
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Contexts Functions

// The Contexts tab: fetch every open task and group it by @context tag. A
// read-only "what's on my plate overall" lens — clicking a row opens the task.
async function fetchOpenTasks() {
    try {
        const open = await apiFetch('/api/tasks/open', { errorMessage: 'Failed to load open tasks' });
        renderContexts(open);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderContexts(openTasks) {
    contextsGrid.innerHTML = '';
    if (openTasks.length === 0) {
        contextsEmptyMsg.style.display = 'flex';
        return;
    }
    contextsEmptyMsg.style.display = 'none';

    const today = getLocalDateString();
    groupByContext(openTasks).forEach(group => {
        // Colour the card only when the context maps to a configured palette slot.
        const color = group.context ? contextColorMap[group.context] : null;
        const label = group.context ? `@${escapeHTML(group.context)}` : 'Untagged';
        const dot = color ? `<span class="color-dot-indicator color-${color}"></span>` : '';

        const card = document.createElement('div');
        card.className = `context-card ${color ? 'color-' + color : ''}`;
        card.innerHTML = `
            <div class="context-card-header">
                ${dot}
                <span class="context-card-title">${label}</span>
                <span class="counter">${group.tasks.length}</span>
            </div>
            <div class="context-card-list">
                ${group.tasks.map(task => contextTaskRow(task, today)).join('')}
            </div>
        `;

        // Double-click to open, matching the board card convention.
        card.querySelectorAll('.context-task').forEach(row => {
            const task = group.tasks.find(t => t.id === row.dataset.id);
            row.addEventListener('dblclick', () => openModal(task));
        });

        contextsGrid.appendChild(card);
    });
}

// One task row inside a context card: title plus a mark for where it currently
// sits (Waiting / Snoozed / Backlog / a due date), derived from its own fields.
function contextTaskRow(task, today) {
    const { kind, date } = deriveTaskState(task, today);
    const marks = {
        waiting: '<span class="context-state waiting">Waiting</span>',
        snoozed: `<span class="context-state snoozed">Snoozed · ${date ? formatShortDate(date) : ''}</span>`,
        backlog: '<span class="context-state backlog">Backlog</span>',
        scheduled: `<span class="context-state scheduled">${date ? formatShortDate(date) : ''}</span>`,
    };
    return `
        <div class="context-task" data-id="${escapeHTML(task.id)}">
            <span class="context-task-title">${escapeHTML(task.title)}</span>
            ${marks[kind]}
        </div>
    `;
}

// Search Functions

async function performSearch() {
    const { text, after, before } = parseSearchQuery(searchInput.value);
    if (!text && !after && !before) {
        searchItemsContainer.innerHTML = '';
        searchEmptyMsg.style.display = 'flex';
        return;
    }
    try {
        const params = new URLSearchParams({ q: text, include_done: searchIncludeDone });
        if (after) params.set('after', after);
        if (before) params.set('before', before);
        const data = await apiFetch(`/api/tasks/search?${params}`, { errorMessage: 'Search failed' });
        renderSearchResults(data.tasks);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderSearchResults(results) {
    searchItemsContainer.innerHTML = '';
    if (results.length === 0) {
        searchEmptyMsg.style.display = 'flex';
        return;
    }
    searchEmptyMsg.style.display = 'none';

    results.forEach(task => {
        const item = document.createElement('div');
        const itemColor = deriveColor(task);
        item.className = `archive-item ${itemColor ? 'color-' + itemColor : ''}`;

        const descHtml = task.description ? `<p class="archive-item-desc">${escapeHTML(task.description)}</p>` : '';

        const metaParts = [];
        if (task.completed) {
            metaParts.push(`<span>Done: ${formatDoneDate(task.completed_at)}</span>`);
        }
        if (task.due_date) {
            const dDue = new Date(task.due_date);
            metaParts.push(`<span>Due: ${dDue.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`);
        }

        const statusPill = task.completed
            ? `<span class="search-status-pill done">Done</span>`
            : `<span class="search-status-pill open">Open</span>`;

        // Done tasks reopen (tray "lift out" icon, matching the Archive tab);
        // open tasks complete (checkmark).
        const completeIcon = task.completed ? ICONS.reopen : ICONS.check;

        item.innerHTML = `
            <div class="archive-item-info">
                <span class="archive-item-title">${escapeHTML(task.title)}</span>
                ${descHtml}
                <div class="archive-item-meta">${metaParts.join('')}</div>
            </div>
            <div class="search-item-actions">
                ${statusPill}
                <div class="row-actions">
                    <button class="action-btn complete-btn" title="${task.completed ? 'Reopen task' : 'Mark as done'}">${completeIcon}</button>
                    <button class="action-btn edit-btn" title="Edit task">${ICONS.edit}</button>
                    <button class="action-btn delete-btn" title="Delete task">${ICONS.trash}</button>
                </div>
            </div>
        `;

        item.querySelector('.complete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            setTaskCompleted(task.id, !task.completed);
        });

        item.querySelector('.edit-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openModal(task);
        });

        item.querySelector('.delete-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            // No confirmation: deletes are soft (recoverable from Archive → Trash)
            await deleteTask(task.id);
            performSearch();
        });

        // Double click row to edit (but not when double-clicking an action button)
        item.addEventListener('dblclick', (e) => {
            if (e.target.closest('.row-actions')) return;
            openModal(task);
        });

        searchItemsContainer.appendChild(item);
    });
}

// One quiet line above the archive list: "12 tasks completed in the last
// 7 days · 3 today". Computed from the first page of results (sorted by
// completed_at desc); if the whole page is within the week and more pages
// exist, the count is shown as "50+". Hidden when the week was quiet.
function renderArchiveSummary(archivedTasks, hasMore) {
    const today = getLocalDateString();
    let weekCount = 0;
    let todayCount = 0;
    archivedTasks.forEach(task => {
        const bucket = archiveBucket(task.completed_at, today);
        if (!bucket || bucket.key.length !== 10) return; // month bucket = older than 7 days
        weekCount++;
        if (bucket.key === today) todayCount++;
    });

    if (weekCount === 0) {
        archiveSummary.style.display = 'none';
        return;
    }
    const plus = hasMore && weekCount === archivedTasks.length ? '+' : '';
    let text = `${weekCount}${plus} task${weekCount === 1 ? '' : 's'} completed in the last 7 days`;
    if (todayCount > 0) text += ` · ${todayCount} today`;
    archiveSummary.textContent = text;
    archiveSummary.style.display = '';
}

function renderArchivedTasks(archivedTasks, append = false) {
    if (!append) {
        archiveItemsContainer.innerHTML = '';
        archiveLastBucketKey = null;
    }
    if (archivedTasks.length === 0 && !append) {
        archiveEmptyMsg.style.display = 'flex';
        return;
    }
    archiveEmptyMsg.style.display = 'none';

    archivedTasks.forEach(task => {
        // Day/month group header (tasks arrive sorted by completed_at desc)
        const bucket = archiveBucket(task.completed_at);
        if (bucket && bucket.key !== archiveLastBucketKey) {
            const header = document.createElement('div');
            header.className = 'archive-day-header';
            header.textContent = bucket.label;
            archiveItemsContainer.appendChild(header);
            archiveLastBucketKey = bucket.key;
        }

        const item = document.createElement('div');
        const itemColor = deriveColor(task);
        item.className = `archive-item ${itemColor ? 'color-' + itemColor : ''}`;
        
        const completedDateFormatted = formatDoneDate(task.completed_at);

        const descHtml = task.description ? `<p class="archive-item-desc">${escapeHTML(task.description)}</p>` : '';
        
        let dueBadge = '';
        if (task.due_date) {
            const dDue = new Date(task.due_date);
            dueBadge = `<span>Due: ${dDue.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`;
        }
        
        item.innerHTML = `
            <div class="archive-item-info">
                <span class="archive-item-title">${escapeHTML(task.title)}</span>
                ${descHtml}
                <div class="archive-item-meta">
                    <span>Done: ${completedDateFormatted}</span>
                    ${dueBadge}
                </div>
            </div>
            <div class="search-item-actions">
                <div class="row-actions">
                    <button class="action-btn reopen-btn" title="Reopen task">${ICONS.reopen}</button>
                    <button class="action-btn edit-btn" title="View / edit task">${ICONS.edit}</button>
                    <button class="action-btn delete-btn" title="Delete task">${ICONS.trash}</button>
                </div>
            </div>
        `;

        item.querySelector('.reopen-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            restoreArchivedTask(task.id);
        });

        item.querySelector('.edit-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openModal(task);
        });

        item.querySelector('.delete-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            // No confirmation: deletes are soft (recoverable from Trash)
            await deleteTask(task.id);
            await fetchArchivedTasks(true);
            await fetchDeletedTasks(true);
        });

        // Double click row to view/edit (but not when double-clicking an action button)
        item.addEventListener('dblclick', (e) => {
            if (e.target.closest('.row-actions')) return;
            openModal(task);
        });

        archiveItemsContainer.appendChild(item);
    });
}

async function restoreArchivedTask(id) {
    try {
        await postTaskAction(id, 'complete', { completed: false }, 'Failed to reopen task');

        showToast('Task reopened.');
        await fetchTasks();
        await fetchArchivedTasks(true);
        await fetchDeletedTasks(true);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Deleted (Trash) Functions
async function fetchDeletedTasks(replace = false) {
    // Trash is the least interesting list, so it is loaded lazily: skip the
    // fetch entirely while the section is folded (it loads on first expand).
    if (!deletedSection.classList.contains('expanded')) return;
    try {
        if (replace) {
            deletedOffset = 0;
        }
        const data = await apiFetch(`/api/tasks/deleted?limit=${PAGE_SIZE}&offset=${deletedOffset}`, { errorMessage: 'Failed to load trash' });

        renderDeletedTasks(data.tasks, !replace);
        
        const loadMoreContainer = document.getElementById('deleted-load-more-container');
        if (data.has_more) {
            loadMoreContainer.style.display = 'flex';
        } else {
            loadMoreContainer.style.display = 'none';
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderDeletedTasks(deletedTasks, append = false) {
    if (!append) {
        deletedItemsContainer.innerHTML = '';
    }
    if (deletedTasks.length === 0 && !append) {
        deletedEmptyMsg.style.display = 'flex';
        return;
    }
    deletedEmptyMsg.style.display = 'none';
    
    deletedTasks.forEach(task => {
        const item = document.createElement('div');
        const itemColor = deriveColor(task);
        item.className = `archive-item ${itemColor ? 'color-' + itemColor : ''}`;
        
        const deletedDateFormatted = formatTimestamp(task.deleted_at, 'recently');

        const descHtml = task.description ? `<p class="archive-item-desc">${escapeHTML(task.description)}</p>` : '';
        
        let dueBadge = '';
        if (task.due_date) {
            const dDue = new Date(task.due_date);
            dueBadge = `<span>Due: ${dDue.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`;
        }
        
        item.innerHTML = `
            <div class="archive-item-info">
                <span class="archive-item-title" style="text-decoration: none; opacity: 0.8;">${escapeHTML(task.title)}</span>
                ${descHtml}
                <div class="archive-item-meta">
                    <span>Deleted: ${deletedDateFormatted}</span>
                    ${dueBadge}
                </div>
            </div>
            <div style="display: flex; gap: 0.5rem;">
                <button class="btn btn-secondary btn-restore-del" data-id="${task.id}">Restore</button>
                <button class="btn btn-delete-perm" data-id="${task.id}">Delete Forever</button>
            </div>
        `;
        
        const restoreBtn = item.querySelector('.btn-restore-del');
        restoreBtn.addEventListener('click', async () => {
            await restoreDeletedTask(task.id);
        });
        
        const deletePermBtn = item.querySelector('.btn-delete-perm');
        deletePermBtn.addEventListener('click', async () => {
            if (confirm('Permanently delete this task? This cannot be undone.')) {
                await deletePermanently(task.id);
            }
        });
        
        deletedItemsContainer.appendChild(item);
    });
}

async function restoreDeletedTask(id) {
    try {
        await postTaskAction(id, 'restore', undefined, 'Failed to restore task');

        showToast('Task restored to workspace.');
        await fetchTasks();
        await fetchArchivedTasks(true);
        await fetchDeletedTasks(true);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deletePermanently(id) {
    try {
        await apiFetch(`/api/tasks/${id}/permanent`, { method: 'DELETE', errorMessage: 'Failed to delete task permanently' });

        showToast('Task permanently deleted.');
        await fetchArchivedTasks(true);
        await fetchDeletedTasks(true);
    } catch (err) {
        showToast(err.message, 'error');
    }
}


// Utility: Show Toast Notifications
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span>${escapeHTML(message)}</span>
    `;
    toastContainer.appendChild(toast);
    
    // Slide out after 3s
    setTimeout(() => {
        toast.classList.add('toast-out');
        toast.addEventListener('animationend', () => {
            toast.remove();
        });
    }, 3000);
}

// Render clickable links found in the description textarea (opens in new tab).
// A chip shows its "label | url" name if given, otherwise just the host.
function renderDescLinks() {
    const links = extractDescLinks(taskDescInput.value);
    if (links.length === 0) {
        descLinks.style.display = 'none';
        descLinks.innerHTML = '';
        return;
    }
    descLinks.innerHTML = links.map(({ url, label }) => {
        const safe = escapeHTML(url);
        // The full URL stays in href + tooltip; the chip text is short.
        const text = escapeHTML(label || formatLinkLabel(url));
        return `<a href="${safe}" class="desc-link" target="_blank" rel="noopener noreferrer" title="${safe}">
            <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
            </svg>
            <span class="desc-link-text">${text}</span>
        </a>`;
    }).join('');
    descLinks.style.display = 'flex';
}

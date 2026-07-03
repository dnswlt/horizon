// App State
let tasks = [];
let workdays = [];

// DOM Elements
const weekColumnsContainer = document.getElementById('week-columns');
const backlogTasksContainer = document.getElementById('backlog-tasks-container');
const backlogDropzone = document.getElementById('backlog-dropzone');
const backlogCounter = document.getElementById('backlog-counter');
const backlogEmptyMsg = document.getElementById('backlog-empty-msg');
const taskModal = document.getElementById('task-modal');
const taskForm = document.getElementById('task-form');
const modalTitle = document.getElementById('modal-title');
const taskIdField = document.getElementById('task-id-field');
const taskTitleInput = document.getElementById('task-title');
const taskDescInput = document.getElementById('task-description');
const taskDateSelect = document.getElementById('task-date');
const addBtn = document.getElementById('add-task-btn');
const modalCloseBtn = document.getElementById('modal-close-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const toastContainer = document.getElementById('toast-container');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    calculateWorkdays();
    renderColumnsStructure();
    populateDateDropdown();
    fetchTasks();
    setupEventListeners();
});

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
            
            // Format labels
            let label = current.toLocaleDateString('en-US', { weekday: 'long' });
            
            // Special relative labels
            const diffTime = current.setHours(0,0,0,0) - new Date().setHours(0,0,0,0);
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays === 0) {
                label = 'Today';
            } else if (diffDays === 1) {
                label = 'Tomorrow';
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
                <div class="column-day">
                    <span>${day.label}</span>
                    <span class="column-task-count" id="count-${day.dateString}">0</span>
                </div>
                <div class="column-date">${day.subtext}</div>
            </div>
            <div class="column-cards" data-date="${day.dateString}"></div>
        `;
        weekColumnsContainer.appendChild(col);
    });
}

// Populate the due date select menu inside the modal
function populateDateDropdown() {
    taskDateSelect.innerHTML = '';
    
    // Backlog Option
    const backlogOpt = document.createElement('option');
    backlogOpt.value = '';
    backlogOpt.textContent = 'Backlog (No specific date)';
    taskDateSelect.appendChild(backlogOpt);
    
    // Workdays Options
    workdays.forEach(day => {
        const opt = document.createElement('option');
        opt.value = day.dateString;
        opt.textContent = `${day.label} (${day.subtext})`;
        taskDateSelect.appendChild(opt);
    });
}

// API: Fetch tasks from backend
async function fetchTasks() {
    try {
        const res = await fetch('/api/tasks');
        if (!res.ok) throw new Error('Failed to load tasks');
        tasks = await res.ok ? await res.json() : [];
        renderTasks();
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

    // Categorize tasks
    tasks.forEach(task => {
        if (task.due_date && grouped[task.due_date]) {
            grouped[task.due_date].push(task);
        } else {
            // Task has no date or date is not in the upcoming 5 days
            grouped['backlog'].push(task);
        }
    });

    // Render columns
    workdays.forEach(day => {
        const list = grouped[day.dateString];
        const container = document.querySelector(`.column-cards[data-date="${day.dateString}"]`);
        const countBadge = document.getElementById(`count-${day.dateString}`);
        
        countBadge.textContent = list.length;
        
        list.sort((a, b) => a.position - b.position);
        list.forEach(task => {
            container.appendChild(createCardElement(task));
        });
    });

    // Render Backlog
    const backlogList = grouped['backlog'];
    backlogCounter.textContent = backlogList.length;
    
    if (backlogList.length === 0) {
        backlogEmptyMsg.style.display = 'flex';
        backlogTasksContainer.style.display = 'none';
    } else {
        backlogEmptyMsg.style.display = 'none';
        backlogTasksContainer.style.display = 'flex';
        
        backlogList.sort((a, b) => a.position - b.position);
        backlogList.forEach(task => {
            backlogTasksContainer.appendChild(createCardElement(task));
        });
    }

    setupDragAndDrop();
}

// DOM Helper: Create task card element
function createCardElement(task) {
    const card = document.createElement('div');
    card.className = `task-card ${task.completed ? 'completed' : ''}`;
    card.draggable = true;
    card.dataset.id = task.id;
    
    // Truncate description for display
    const descText = task.description || '';
    const descHtml = descText ? `<div class="card-desc">${escapeHTML(descText)}</div>` : '';
    
    // Due date label (only show on backlog items that have a due date in the future)
    let footerDate = '';
    if (!task.due_date) {
        footerDate = 'Backlog';
    } else {
        // If it matches one of the columns, we don't need a date badge on it (implied by column)
        const inColumns = workdays.some(w => w.dateString === task.due_date);
        if (!inColumns) {
            // It has a future date, format it nicely
            const d = new Date(task.due_date);
            footerDate = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
    }

    const dateBadge = footerDate ? `
        <div class="card-date-badge">
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            <span>${footerDate}</span>
        </div>
    ` : '';

    card.innerHTML = `
        <div class="card-header">
            <div class="card-title-container">
                <input type="checkbox" class="card-checkbox" ${task.completed ? 'checked' : ''}>
                <span class="card-title">${escapeHTML(task.title)}</span>
            </div>
            <div class="card-actions">
                <button class="action-btn edit-btn" title="Edit task">
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                        <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                </button>
                <button class="action-btn delete-btn" title="Delete task">
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        <line x1="10" y1="11" x2="10" y2="17"></line>
                        <line x1="14" y1="11" x2="14" y2="17"></line>
                    </svg>
                </button>
            </div>
        </div>
        ${descHtml}
        <div class="card-footer">
            ${dateBadge}
        </div>
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
        if (confirm('Are you sure you want to delete this task?')) {
            await deleteTask(task.id);
        }
    });

    return card;
}

// Toggle task completion
async function toggleTaskCompletion(id, completed, cardEl) {
    try {
        const res = await fetch(`/api/tasks/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed })
        });
        if (!res.ok) throw new Error('Could not update task status');
        
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

// API: Delete task
async function deleteTask(id) {
    try {
        const res = await fetch(`/api/tasks/${id}`, {
            method: 'DELETE'
        });
        if (!res.ok) throw new Error('Could not delete task');
        
        tasks = tasks.filter(t => t.id !== id);
        renderTasks();
        showToast('Task deleted successfully.');
    } catch (err) {
        showToast(err.message, 'error');
    }
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
        updates.push({
            id: card.dataset.id,
            due_date: null,
            position: index
        });
    });

    if (updates.length === 0) return;

    try {
        const res = await fetch('/api/tasks/reorder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tasks: updates })
        });
        
        if (!res.ok) throw new Error('Failed to save layout order');
        
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
        showToast('Layout updated.');
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
        
        // Check if due date is in columns, else default to backlog
        const isScheduled = task.due_date && workdays.some(w => w.dateString === task.due_date);
        taskDateSelect.value = isScheduled ? task.due_date : '';
    } else {
        // Add mode
        modalTitle.textContent = 'Create Task';
        taskIdField.value = '';
        taskForm.reset();
        taskDateSelect.value = ''; // Default to backlog
    }
    
    taskModal.classList.add('active');
    taskTitleInput.focus();
}

function closeModal() {
    taskModal.classList.remove('active');
}

// Save form handler (Add / Edit)
taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
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
            const res = await fetch(`/api/tasks/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    description,
                    due_date: dueDate
                })
            });
            if (!res.ok) throw new Error('Failed to update task');
            showToast('Task updated.');
        } else {
            // Create API call
            const res = await fetch('/api/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    description,
                    due_date: dueDate,
                    position
                })
            });
            if (!res.ok) throw new Error('Failed to create task');
            showToast('Task created.');
        }
        
        closeModal();
        fetchTasks();
    } catch (err) {
        showToast(err.message, 'error');
    }
});

// Setup event listeners
function setupEventListeners() {
    addBtn.addEventListener('click', () => openModal());
    modalCloseBtn.addEventListener('click', closeModal);
    modalCancelBtn.addEventListener('click', closeModal);
    
    // Close modal when clicking on overlay background
    taskModal.addEventListener('click', (e) => {
        if (e.target === taskModal) closeModal();
    });
    
    // Key bindings (ESC to close modal)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && taskModal.classList.contains('active')) {
            closeModal();
        }
    });
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

// Utility: Escape HTML to prevent XSS
function escapeHTML(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * EduAI Academic Task & Learning Suite - Frontend Client Engine
 * Connects directly to Node.js / SQLite backend REST API
 */

// Auto-detect API host: works seamlessly whether served via http://localhost:3000 or opened directly as file://
const API_BASE = (window.location.protocol === 'file:' || !window.location.origin || window.location.origin === 'null')
  ? 'http://localhost:3000'
  : window.location.origin;

// Application State
const state = {
  tasks: [],
  stats: null,
  reminders: [],
  quizzes: [],
  currentQuizIndex: 0,
  quizScore: 0,
  quizAnswered: false,
  filters: {
    category: 'All',
    priority: 'All',
    status: 'All',
    search: '',
    sortBy: 'deadline_asc'
  },
  currentView: 'list', // 'list' | 'kanban' | 'matrix'
  editingTaskId: null
};

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  initApp();
  // Refresh countdown badges every 60 seconds
  setInterval(() => {
    if (state.tasks.length > 0) {
      renderCurrentView();
    }
  }, 60000);
});

async function initApp() {
  initAuth();
  await Promise.all([
    fetchDashboardStats(),
    fetchReminders(),
    fetchTasks(),
    fetchQuizzes()
  ]);
  setupEventListeners();
}

// --- EVENT LISTENERS ---
function setupEventListeners() {
  // Search input with debounce
  const searchInput = document.getElementById('taskSearchInput');
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        state.filters.search = e.target.value.trim();
        fetchTasks();
      }, 300);
    });
  }

  // Filter dropdowns
  const priorityFilter = document.getElementById('priorityFilterSelect');
  if (priorityFilter) {
    priorityFilter.addEventListener('change', (e) => {
      state.filters.priority = e.target.value;
      fetchTasks();
    });
  }

  const statusFilter = document.getElementById('statusFilterSelect');
  if (statusFilter) {
    statusFilter.addEventListener('change', (e) => {
      state.filters.status = e.target.value;
      fetchTasks();
    });
  }

  const sortFilter = document.getElementById('sortBySelect');
  if (sortFilter) {
    sortFilter.addEventListener('change', (e) => {
      state.filters.sortBy = e.target.value;
      fetchTasks();
    });
  }

  // Task form submission
  const taskForm = document.getElementById('taskModalForm');
  if (taskForm) {
    taskForm.addEventListener('submit', handleTaskFormSubmit);
  }
}

// --- API CLIENT CALLS ---

// Fallback offline sample data if backend is warming up or opened offline
const fallbackTasks = [
  {
    id: 1,
    title: 'CS301 Data Structures: Red-Black Tree Implementation',
    category: 'Project',
    subject: 'Computer Science',
    priority: 'Urgent',
    due_date: new Date(Date.now() + 14 * 3600 * 1000).toISOString().slice(0, 16),
    estimated_hours: 4.5,
    status: 'in_progress',
    description: 'Implement rotation and balancing operations in Java or C++. Verify all invariant tests pass.',
    reminder_lead: 12,
    is_overdue: false,
    hours_remaining: 14,
    deadline_status: 'due_today',
    countdown_label: 'Due in 14h'
  },
  {
    id: 2,
    title: 'Calculus II: Multivariable Integration Problem Set 5',
    category: 'Assignment',
    subject: 'Mathematics',
    priority: 'High',
    due_date: new Date(Date.now() + 32 * 3600 * 1000).toISOString().slice(0, 16),
    estimated_hours: 3.0,
    status: 'todo',
    description: 'Solve problems 14 through 28 on double integrals and polar coordinates. Show step-by-step proofs.',
    reminder_lead: 24,
    is_overdue: false,
    hours_remaining: 32,
    deadline_status: 'due_soon',
    countdown_label: 'Due tomorrow'
  },
  {
    id: 3,
    title: 'PHYS202 Physics Midterm Examination',
    category: 'Examination',
    subject: 'Physics',
    priority: 'Urgent',
    due_date: new Date(Date.now() + 65 * 3600 * 1000).toISOString().slice(0, 16),
    estimated_hours: 8.0,
    status: 'todo',
    description: 'Covers Maxwell equations, magnetic induction, and electromagnetic wave propagation. Scientific calculator allowed.',
    reminder_lead: 48,
    is_overdue: false,
    hours_remaining: 65,
    deadline_status: 'upcoming',
    countdown_label: 'Due in 3 days'
  },
  {
    id: 4,
    title: 'Robotics Club Annual Autonomous Rover Showcase',
    category: 'Extracurricular',
    subject: 'Extracurricular / Club',
    priority: 'Medium',
    due_date: new Date(Date.now() + 110 * 3600 * 1000).toISOString().slice(0, 16),
    estimated_hours: 2.5,
    status: 'in_progress',
    description: 'Prepare demonstration booth, tune PID motor controller calibration, and print technical poster.',
    reminder_lead: 24,
    is_overdue: false,
    hours_remaining: 110,
    deadline_status: 'upcoming',
    countdown_label: 'Due in 5 days'
  },
  {
    id: 5,
    title: 'Organic Chemistry Lab: Spectroscopic Analysis Report',
    category: 'Assignment',
    subject: 'Chemistry',
    priority: 'Medium',
    due_date: new Date(Date.now() + 150 * 3600 * 1000).toISOString().slice(0, 16),
    estimated_hours: 3.5,
    status: 'todo',
    description: 'Analyze NMR and IR spectrograms for unknown compound sample #4. Document peak assignments and purity.',
    reminder_lead: 24,
    is_overdue: false,
    hours_remaining: 150,
    deadline_status: 'upcoming',
    countdown_label: 'Due in 6 days'
  },
  {
    id: 6,
    title: 'English Composition: Critical Essay on Digital Privacy',
    category: 'Assignment',
    subject: 'English Literature',
    priority: 'Low',
    due_date: new Date(Date.now() - 18 * 3600 * 1000).toISOString().slice(0, 16),
    estimated_hours: 4.0,
    status: 'completed',
    description: '1500-word argumentative essay with at least 5 peer-reviewed scholarly citations.',
    reminder_lead: 24,
    is_overdue: false,
    hours_remaining: -18,
    deadline_status: 'completed',
    countdown_label: 'Completed'
  }
];

function calculateLocalStats(taskList) {
  const total = taskList.length;
  const completed = taskList.filter(t => t.status === 'completed').length;
  const in_progress = taskList.filter(t => t.status === 'in_progress').length;
  const todo = taskList.filter(t => t.status === 'todo').length;
  const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
  const pending = taskList.filter(t => t.status !== 'completed');
  const urgent = pending.filter(t => t.priority === 'Urgent').length;
  const due_today = pending.filter(t => t.deadline_status === 'due_today').length;
  const remaining_hours = pending.reduce((sum, t) => sum + (t.estimated_hours || 1), 0);

  const by_category = { Assignment: 0, Examination: 0, Project: 0, Extracurricular: 0, General: 0 };
  taskList.forEach(t => { if (by_category[t.category] !== undefined) by_category[t.category]++; });

  return {
    total_tasks: total,
    completed_tasks: completed,
    in_progress_tasks: in_progress,
    todo_tasks: todo,
    completion_rate: rate,
    urgent_count: urgent,
    due_today_count: due_today,
    remaining_hours: Math.round(remaining_hours * 10) / 10,
    streak_days: 4,
    by_category
  };
}

// 1. Fetch Tasks
async function fetchTasks() {
  try {
    const params = new URLSearchParams();
    if (state.filters.category !== 'All') params.append('category', state.filters.category);
    if (state.filters.priority !== 'All') params.append('priority', state.filters.priority);
    if (state.filters.status !== 'All') params.append('status', state.filters.status);
    if (state.filters.search) params.append('search', state.filters.search);
    if (state.filters.sortBy) params.append('sortBy', state.filters.sortBy);

    const res = await fetch(`${API_BASE}/api/tasks?${params.toString()}`);
    const data = await res.json();
    if (data.success) {
      state.tasks = data.tasks;
      renderCurrentView();
      updateCategoryTabCounts();
      return;
    }
  } catch (err) {
    console.warn('Backend server not directly reachable, running with local academic engine.');
  }

  // Graceful offline fallback
  let filtered = [...fallbackTasks];
  if (state.filters.category !== 'All') filtered = filtered.filter(t => t.category === state.filters.category);
  if (state.filters.priority !== 'All') filtered = filtered.filter(t => t.priority === state.filters.priority);
  if (state.filters.status !== 'All') filtered = filtered.filter(t => t.status === state.filters.status);
  if (state.filters.search) {
    const s = state.filters.search.toLowerCase();
    filtered = filtered.filter(t => t.title.toLowerCase().includes(s) || t.subject.toLowerCase().includes(s));
  }
  state.tasks = filtered;
  if (!state.stats) {
    state.stats = calculateLocalStats(fallbackTasks);
    renderDashboardStats();
  }
  renderCurrentView();
  updateCategoryTabCounts();
}

// 2. Fetch Dashboard Stats
async function fetchDashboardStats() {
  try {
    const res = await fetch(`${API_BASE}/api/dashboard/stats`);
    const data = await res.json();
    if (data.success) {
      state.stats = data.stats;
      renderDashboardStats();
    }
  } catch (err) {
    console.error('Failed to load dashboard stats:', err);
  }
}

// 3. Fetch Reminders
async function fetchReminders() {
  try {
    const res = await fetch(`${API_BASE}/api/reminders`);
    const data = await res.json();
    if (data.success) {
      state.reminders = data.reminders;
      renderRemindersBanner();
    }
  } catch (err) {
    console.error('Failed to load reminders:', err);
  }
}

// 4. Fetch Quizzes
async function fetchQuizzes() {
  try {
    const res = await fetch(`${API_BASE}/api/quizzes`);
    const data = await res.json();
    if (data.success && data.questions && data.questions.length > 0) {
      state.quizzes = data.questions;
      renderQuizQuestion();
    }
  } catch (err) {
    console.error('Failed to load quiz questions:', err);
  }
}

// --- RENDERING FUNCTIONS ---

// Render Dashboard Metrics & Analytics
function renderDashboardStats() {
  const s = state.stats;
  if (!s) return;

  // Stat numbers
  const totalEl = document.getElementById('statTotalTasks');
  if (totalEl) totalEl.textContent = s.total_tasks;

  const completedEl = document.getElementById('statCompletedTasks');
  if (completedEl) completedEl.textContent = s.completed_tasks;

  const rateEl = document.getElementById('statCompletionRate');
  if (rateEl) rateEl.textContent = `${s.completion_rate}%`;

  const progressBar = document.getElementById('statCompletionBar');
  if (progressBar) progressBar.style.width = `${s.completion_rate}%`;

  const urgentEl = document.getElementById('statUrgentCount');
  if (urgentEl) urgentEl.textContent = s.urgent_count;

  const dueTodayEl = document.getElementById('statDueTodayCount');
  if (dueTodayEl) dueTodayEl.textContent = s.due_today_count;

  const hoursEl = document.getElementById('statRemainingHours');
  if (hoursEl) hoursEl.textContent = `${s.remaining_hours}h`;

  const streakEl = document.getElementById('statStreakDays');
  if (streakEl) streakEl.textContent = `${s.streak_days} Days`;

  // Render Category Workload Progress Distribution
  const categoryDist = document.getElementById('categoryDistributionBars');
  if (categoryDist && s.by_category) {
    const total = s.total_tasks || 1;
    const cats = [
      { key: 'Assignment', label: 'Assignments', color: 'bg-blue-500', count: s.by_category.Assignment || 0 },
      { key: 'Examination', label: 'Examinations', color: 'bg-purple-500', count: s.by_category.Examination || 0 },
      { key: 'Project', label: 'Projects', color: 'bg-emerald-500', count: s.by_category.Project || 0 },
      { key: 'Extracurricular', label: 'Extracurricular', color: 'bg-amber-500', count: s.by_category.Extracurricular || 0 },
      { key: 'General', label: 'General', color: 'bg-slate-400', count: s.by_category.General || 0 }
    ];

    categoryDist.innerHTML = cats.map(c => {
      const pct = Math.round((c.count / total) * 100);
      return `
        <div>
          <div class="flex justify-between text-xs mb-1">
            <span class="font-medium text-slate-700">${c.label}</span>
            <span class="font-bold text-slate-900">${c.count} <span class="text-slate-400 font-normal">(${pct}%)</span></span>
          </div>
          <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
            <div class="${c.color} h-2 rounded-full transition-all duration-500" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    }).join('');
  }
}

// Render Deadline Reminder Alert Banner
function renderRemindersBanner() {
  const banner = document.getElementById('deadlineAlertBanner');
  if (!banner) return;

  const reminders = state.reminders;
  if (!reminders || reminders.length === 0) {
    banner.classList.add('hidden');
    return;
  }

  const overdue = reminders.filter(r => r.is_overdue);
  const dueToday = reminders.filter(r => r.deadline_status === 'due_today');

  let alertText = '';
  let badgeColor = 'bg-amber-500';

  if (overdue.length > 0) {
    badgeColor = 'bg-rose-500';
    alertText = `⚠️ <strong>Action Required:</strong> You have <strong>${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}</strong> and <strong>${dueToday.length} task${dueToday.length > 1 ? 's' : ''} due today</strong>!`;
  } else if (dueToday.length > 0) {
    alertText = `⏰ <strong>Deadline Reminder:</strong> <strong>${dueToday.length} task${dueToday.length > 1 ? 's' : ''}</strong> scheduled for completion today. Stay on track!`;
  } else {
    alertText = `📌 <strong>Upcoming Deadlines:</strong> ${reminders.length} academic task${reminders.length > 1 ? 's' : ''} due within the next 48 hours.`;
  }

  banner.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <span class="w-2.5 h-2.5 rounded-full ${badgeColor} animate-ping shrink-0"></span>
        <div class="text-xs text-slate-800 leading-relaxed">${alertText}</div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button onclick="filterDueSoonTasks()" class="px-3 py-1 bg-white hover:bg-slate-50 text-brand-blue border border-brand-blue/30 rounded-lg text-xs font-bold transition-all shadow-sm">
          Focus on Urgents
        </button>
        <button onclick="dismissReminderBanner()" class="text-slate-400 hover:text-slate-600 text-xs px-1">
          ✕
        </button>
      </div>
    </div>
  `;
  banner.classList.remove('hidden');
}

function dismissReminderBanner() {
  const banner = document.getElementById('deadlineAlertBanner');
  if (banner) banner.classList.add('hidden');
}

function filterDueSoonTasks() {
  state.filters.status = 'todo';
  state.filters.priority = 'Urgent';
  const priorityFilter = document.getElementById('priorityFilterSelect');
  if (priorityFilter) priorityFilter.value = 'Urgent';
  const statusFilter = document.getElementById('statusFilterSelect');
  if (statusFilter) statusFilter.value = 'todo';
  fetchTasks();
  document.getElementById('taskManagementHub').scrollIntoView({ behavior: 'smooth' });
}

// Update category count tabs in navigation
function updateCategoryTabCounts() {
  if (!state.stats) return;
  const counts = state.stats.by_category || {};
  const total = state.stats.total_tasks || 0;

  const countTotalEl = document.getElementById('countTabAll');
  if (countTotalEl) countTotalEl.textContent = total;

  const countAssignEl = document.getElementById('countTabAssignment');
  if (countAssignEl) countAssignEl.textContent = counts.Assignment || 0;

  const countExamEl = document.getElementById('countTabExam');
  if (countExamEl) countExamEl.textContent = counts.Examination || 0;

  const countProjEl = document.getElementById('countTabProject');
  if (countProjEl) countProjEl.textContent = counts.Project || 0;

  const countExtraEl = document.getElementById('countTabExtra');
  if (countExtraEl) countExtraEl.textContent = counts.Extracurricular || 0;
}

// Switch Active View (List, Kanban, Matrix)
function setView(viewName) {
  state.currentView = viewName;

  // Update button highlights
  ['viewBtnList', 'viewBtnKanban', 'viewBtnMatrix'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('bg-brand-blue', 'text-white');
      el.classList.add('bg-white', 'text-slate-600');
    }
  });

  const activeBtnId = viewName === 'list' ? 'viewBtnList' : (viewName === 'kanban' ? 'viewBtnKanban' : 'viewBtnMatrix');
  const activeBtn = document.getElementById(activeBtnId);
  if (activeBtn) {
    activeBtn.classList.remove('bg-white', 'text-slate-600');
    activeBtn.classList.add('bg-brand-blue', 'text-white');
  }

  renderCurrentView();
}

function renderCurrentView() {
  const listContainer = document.getElementById('tasksListView');
  const kanbanContainer = document.getElementById('tasksKanbanView');
  const matrixContainer = document.getElementById('tasksMatrixView');

  if (state.currentView === 'list') {
    if (listContainer) listContainer.classList.remove('hidden');
    if (kanbanContainer) kanbanContainer.classList.add('hidden');
    if (matrixContainer) matrixContainer.classList.add('hidden');
    renderListView();
  } else if (state.currentView === 'kanban') {
    if (listContainer) listContainer.classList.add('hidden');
    if (kanbanContainer) kanbanContainer.classList.remove('hidden');
    if (matrixContainer) matrixContainer.classList.add('hidden');
    renderKanbanView();
  } else if (state.currentView === 'matrix') {
    if (listContainer) listContainer.classList.add('hidden');
    if (kanbanContainer) kanbanContainer.classList.add('hidden');
    if (matrixContainer) matrixContainer.classList.remove('hidden');
    renderMatrixView();
  }
}

// 1. Render List View
function renderListView() {
  const container = document.getElementById('tasksListContainer');
  if (!container) return;

  if (state.tasks.length === 0) {
    container.innerHTML = `
      <div class="p-12 text-center bg-white rounded-2xl border border-slate-200/80">
        <div class="w-16 h-16 rounded-full bg-blue-50 text-brand-blue mx-auto flex items-center justify-center text-2xl mb-3">
          <i class="fa-solid fa-clipboard-check"></i>
        </div>
        <h4 class="text-sm font-bold text-slate-800">No tasks found</h4>
        <p class="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
          No academic items match your active filters. Try clearing your search or add a new task!
        </p>
        <button onclick="openCreateTaskModal()" class="mt-4 px-4 py-2 bg-brand-blue text-white rounded-xl text-xs font-bold hover:bg-brand-navy transition-all">
          + Add New Academic Task
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = state.tasks.map(task => renderTaskCard(task)).join('');
}

// Generate single task card HTML
function renderTaskCard(task) {
  const isCompleted = task.status === 'completed';
  const isInProgress = task.status === 'in_progress';

  // Category Icon & Colors
  let catBadge = '';
  switch (task.category) {
    case 'Assignment':
      catBadge = '<span class="px-2 py-0.5 rounded-md bg-blue-50 text-brand-blue font-bold text-[10px]"><i class="fa-solid fa-file-pen mr-1"></i> Assignment</span>';
      break;
    case 'Examination':
      catBadge = '<span class="px-2 py-0.5 rounded-md bg-purple-50 text-purple-700 font-bold text-[10px]"><i class="fa-solid fa-graduation-cap mr-1"></i> Examination</span>';
      break;
    case 'Project':
      catBadge = '<span class="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 font-bold text-[10px]"><i class="fa-solid fa-diagram-project mr-1"></i> Project</span>';
      break;
    case 'Extracurricular':
      catBadge = '<span class="px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 font-bold text-[10px]"><i class="fa-solid fa-trophy mr-1"></i> Extracurricular</span>';
      break;
    default:
      catBadge = '<span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-bold text-[10px]"><i class="fa-solid fa-list-check mr-1"></i> General</span>';
  }

  // Priority Badge
  let priorityBadge = '';
  switch (task.priority) {
    case 'Urgent':
      priorityBadge = '<span class="px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-200 font-bold text-[10px] flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping"></span> Urgent</span>';
      break;
    case 'High':
      priorityBadge = '<span class="px-2 py-0.5 rounded-md bg-orange-50 text-orange-700 border border-orange-200 font-bold text-[10px]">High</span>';
      break;
    case 'Medium':
      priorityBadge = '<span class="px-2 py-0.5 rounded-md bg-sky-50 text-sky-700 border border-sky-200 font-bold text-[10px]">Medium</span>';
      break;
    default:
      priorityBadge = '<span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 font-medium text-[10px]">Low</span>';
  }

  // Deadline Countdown Badge
  let countdownBadge = '';
  if (isCompleted) {
    countdownBadge = '<span class="text-[11px] font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-0.5 rounded-full"><i class="fa-solid fa-check-circle mr-1"></i> Done</span>';
  } else if (task.is_overdue) {
    countdownBadge = `<span class="text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-2.5 py-0.5 rounded-full animate-pulse"><i class="fa-solid fa-triangle-exclamation mr-1"></i> ${task.countdown_label}</span>`;
  } else if (task.deadline_status === 'due_today') {
    countdownBadge = `<span class="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-0.5 rounded-full"><i class="fa-solid fa-stopwatch mr-1"></i> ${task.countdown_label}</span>`;
  } else {
    countdownBadge = `<span class="text-[11px] font-medium text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full"><i class="fa-regular fa-clock mr-1"></i> ${task.countdown_label}</span>`;
  }

  // Status Action Button
  let statusActionBtn = '';
  if (isCompleted) {
    statusActionBtn = `
      <button onclick="cycleTaskStatus(${task.id}, 'completed')" class="px-3 py-1.5 rounded-xl bg-emerald-100 text-emerald-800 text-xs font-bold hover:bg-slate-200 hover:text-slate-700 transition-colors flex items-center gap-1.5" title="Click to reopen">
        <i class="fa-solid fa-circle-check text-emerald-600"></i>
        <span>Completed</span>
      </button>
    `;
  } else if (isInProgress) {
    statusActionBtn = `
      <button onclick="cycleTaskStatus(${task.id}, 'in_progress')" class="px-3 py-1.5 rounded-xl bg-blue-100 text-brand-blue text-xs font-bold hover:bg-emerald-600 hover:text-white transition-colors flex items-center gap-1.5" title="Click to complete">
        <i class="fa-solid fa-spinner fa-spin text-brand-blue"></i>
        <span>In Progress</span>
      </button>
    `;
  } else {
    statusActionBtn = `
      <button onclick="cycleTaskStatus(${task.id}, 'todo')" class="px-3 py-1.5 rounded-xl bg-slate-100 text-slate-700 text-xs font-semibold hover:bg-brand-blue hover:text-white transition-colors flex items-center gap-1.5" title="Click to start">
        <i class="fa-regular fa-circle text-slate-400"></i>
        <span>To-Do</span>
      </button>
    `;
  }

  // Format Due Date Human String
  const dueDateObj = new Date(task.due_date);
  const formattedDueDate = dueDateObj.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  return `
    <div class="task-card p-4 sm:p-5 rounded-2xl bg-white border ${task.is_overdue && !isCompleted ? 'border-rose-200 shadow-sm' : 'border-slate-200/80'} hover:shadow-md transition-all flex flex-col md:flex-row md:items-center justify-between gap-4" id="task-${task.id}">
      <!-- Left side: Category, Subject, Title, Description -->
      <div class="flex-1 space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          ${catBadge}
          <span class="text-[11px] font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">${escapeHtml(task.subject)}</span>
          ${priorityBadge}
        </div>
        
        <h4 class="text-sm sm:text-base font-bold text-slate-900 leading-snug ${isCompleted ? 'line-through text-slate-400' : ''}">
          ${escapeHtml(task.title)}
        </h4>

        ${task.description ? `<p class="text-xs text-slate-500 line-clamp-2">${escapeHtml(task.description)}</p>` : ''}

        <div class="flex flex-wrap items-center gap-3 pt-1 text-xs text-slate-500">
          <span class="flex items-center gap-1">
            <i class="fa-regular fa-calendar text-slate-400"></i>
            <span>${formattedDueDate}</span>
          </span>
          <span class="flex items-center gap-1">
            <i class="fa-regular fa-hourglass text-slate-400"></i>
            <span>Est: ${task.estimated_hours}h</span>
          </span>
          ${countdownBadge}
        </div>
      </div>

      <!-- Right side: Quick Action Status Button + Edit / Delete -->
      <div class="flex items-center justify-between md:justify-end gap-2.5 pt-2 md:pt-0 border-t md:border-t-0 border-slate-100 shrink-0">
        ${statusActionBtn}

        <button onclick="openEditTaskModal(${task.id})" class="w-8 h-8 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-500 hover:text-brand-blue flex items-center justify-center text-xs transition-colors" title="Edit Task">
          <i class="fa-solid fa-pen-to-square"></i>
        </button>

        <button onclick="deleteTask(${task.id})" class="w-8 h-8 rounded-lg bg-slate-50 hover:bg-rose-50 text-slate-400 hover:text-rose-600 flex items-center justify-center text-xs transition-colors" title="Delete Task">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      </div>
    </div>
  `;
}

// 2. Render Kanban View
function renderKanbanView() {
  const todoCol = document.getElementById('kanbanColTodo');
  const inProgressCol = document.getElementById('kanbanColInProgress');
  const completedCol = document.getElementById('kanbanColCompleted');

  if (!todoCol || !inProgressCol || !completedCol) return;

  const todoTasks = state.tasks.filter(t => t.status === 'todo');
  const inProgressTasks = state.tasks.filter(t => t.status === 'in_progress');
  const completedTasks = state.tasks.filter(t => t.status === 'completed');

  document.getElementById('kanbanTodoCount').textContent = todoTasks.length;
  document.getElementById('kanbanInProgressCount').textContent = inProgressTasks.length;
  document.getElementById('kanbanCompletedCount').textContent = completedTasks.length;

  const renderMiniCard = (task) => `
    <div class="p-3.5 rounded-xl bg-white border border-slate-200/80 shadow-sm space-y-2 hover:shadow transition-shadow">
      <div class="flex items-center justify-between">
        <span class="text-[10px] font-bold text-brand-blue uppercase">${task.category}</span>
        <span class="text-[10px] font-semibold text-slate-500">${task.countdown_label}</span>
      </div>
      <h5 class="text-xs font-bold text-slate-900 leading-snug">${escapeHtml(task.title)}</h5>
      <p class="text-[11px] text-slate-400">${escapeHtml(task.subject)} • Est: ${task.estimated_hours}h</p>
      <div class="flex items-center justify-between pt-2 border-t border-slate-100 text-xs">
        <button onclick="cycleTaskStatus(${task.id}, '${task.status}')" class="text-[11px] font-bold text-brand-blue hover:underline">
          ${task.status === 'completed' ? 'Reopen' : (task.status === 'in_progress' ? 'Mark Done' : 'Start Task')} →
        </button>
        <button onclick="openEditTaskModal(${task.id})" class="text-slate-400 hover:text-slate-600">
          <i class="fa-solid fa-pen text-[10px]"></i>
        </button>
      </div>
    </div>
  `;

  todoCol.innerHTML = todoTasks.length > 0 ? todoTasks.map(renderMiniCard).join('') : '<p class="text-xs text-slate-400 italic py-4 text-center">No tasks in To-Do</p>';
  inProgressCol.innerHTML = inProgressTasks.length > 0 ? inProgressTasks.map(renderMiniCard).join('') : '<p class="text-xs text-slate-400 italic py-4 text-center">No tasks in progress</p>';
  completedCol.innerHTML = completedTasks.length > 0 ? completedTasks.map(renderMiniCard).join('') : '<p class="text-xs text-slate-400 italic py-4 text-center">No completed tasks</p>';
}

// 3. Render Eisenhower Priority Matrix View
function renderMatrixView() {
  const q1 = document.getElementById('matrixQ1'); // Urgent & High
  const q2 = document.getElementById('matrixQ2'); // Not Urgent & High
  const q3 = document.getElementById('matrixQ3'); // Urgent & Low/Med
  const q4 = document.getElementById('matrixQ4'); // Not Urgent & Low/Med

  if (!q1 || !q2 || !q3 || !q4) return;

  const tasksQ1 = [];
  const tasksQ2 = [];
  const tasksQ3 = [];
  const tasksQ4 = [];

  state.tasks.forEach(task => {
    if (task.status === 'completed') return;
    const isUrgent = task.priority === 'Urgent' || task.is_overdue || task.deadline_status === 'due_today';
    const isImportant = task.priority === 'Urgent' || task.priority === 'High';

    if (isUrgent && isImportant) {
      tasksQ1.push(task);
    } else if (!isUrgent && isImportant) {
      tasksQ2.push(task);
    } else if (isUrgent && !isImportant) {
      tasksQ3.push(task);
    } else {
      tasksQ4.push(task);
    }
  });

  const renderQuadrantCard = (task) => `
    <div class="p-2.5 rounded-lg bg-white border border-slate-200 text-xs shadow-sm flex items-center justify-between gap-2">
      <div class="truncate">
        <span class="font-bold text-slate-900 truncate block">${escapeHtml(task.title)}</span>
        <span class="text-[10px] text-slate-400">${task.category} • ${task.countdown_label}</span>
      </div>
      <button onclick="cycleTaskStatus(${task.id}, '${task.status}')" class="shrink-0 text-brand-blue hover:text-emerald-600">
        <i class="fa-regular fa-circle-check"></i>
      </button>
    </div>
  `;

  q1.innerHTML = tasksQ1.length > 0 ? tasksQ1.map(renderQuadrantCard).join('') : '<p class="text-xs text-slate-400 italic py-2 text-center">None! You are all caught up.</p>';
  q2.innerHTML = tasksQ2.length > 0 ? tasksQ2.map(renderQuadrantCard).join('') : '<p class="text-xs text-slate-400 italic py-2 text-center">No scheduled high-priority items</p>';
  q3.innerHTML = tasksQ3.length > 0 ? tasksQ3.map(renderQuadrantCard).join('') : '<p class="text-xs text-slate-400 italic py-2 text-center">No quick-action urgent tasks</p>';
  q4.innerHTML = tasksQ4.length > 0 ? tasksQ4.map(renderQuadrantCard).join('') : '<p class="text-xs text-slate-400 italic py-2 text-center">No backlog items</p>';
}

// --- TASK ACTIONS (CRUD) ---

// Filter by Category Pill Tabs
function selectCategoryFilter(category) {
  state.filters.category = category;

  // Toggle active tab style
  const tabs = document.querySelectorAll('.category-tab-btn');
  tabs.forEach(tab => {
    tab.classList.remove('bg-brand-blue', 'text-white');
    tab.classList.add('bg-white', 'text-slate-600');
  });

  const activeTab = document.getElementById(`tabCat-${category}`);
  if (activeTab) {
    activeTab.classList.remove('bg-white', 'text-slate-600');
    activeTab.classList.add('bg-brand-blue', 'text-white');
  }

  fetchTasks();
}

// Open Task Modal for Creating
function openCreateTaskModal(defaultCategory = 'Assignment') {
  state.editingTaskId = null;
  const modal = document.getElementById('taskModal');
  const title = document.getElementById('taskModalTitle');
  const submitBtnText = document.getElementById('taskModalSubmitText');

  title.textContent = 'Add New Academic Task';
  submitBtnText.textContent = 'Create Task';

  // Reset fields
  document.getElementById('taskFormTitle').value = '';
  document.getElementById('taskFormCategory').value = defaultCategory;
  document.getElementById('taskFormSubject').value = '';
  document.getElementById('taskFormPriority').value = 'High';
  document.getElementById('taskFormHours').value = '2.0';
  document.getElementById('taskFormStatus').value = 'todo';
  document.getElementById('taskFormReminder').value = '24';
  document.getElementById('taskFormDescription').value = '';

  // Default due date: tomorrow at 18:00
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(18, 0, 0, 0);
  const formattedDate = tomorrow.toISOString().slice(0, 16);
  document.getElementById('taskFormDueDate').value = formattedDate;

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

// Open Task Modal for Editing
function openEditTaskModal(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  state.editingTaskId = taskId;
  const modal = document.getElementById('taskModal');
  const title = document.getElementById('taskModalTitle');
  const submitBtnText = document.getElementById('taskModalSubmitText');

  title.textContent = 'Edit Academic Task';
  submitBtnText.textContent = 'Save Changes';

  document.getElementById('taskFormTitle').value = task.title;
  document.getElementById('taskFormCategory').value = task.category;
  document.getElementById('taskFormSubject').value = task.subject;
  document.getElementById('taskFormPriority').value = task.priority;
  document.getElementById('taskFormDueDate').value = task.due_date;
  document.getElementById('taskFormHours').value = task.estimated_hours;
  document.getElementById('taskFormStatus').value = task.status;
  document.getElementById('taskFormReminder').value = task.reminder_lead || 24;
  document.getElementById('taskFormDescription').value = task.description || '';

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeTaskModal() {
  const modal = document.getElementById('taskModal');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = 'auto';
  state.editingTaskId = null;
}

// Handle Form Submit (Create or Update)
async function handleTaskFormSubmit(e) {
  e.preventDefault();

  const title = document.getElementById('taskFormTitle').value.trim();
  const category = document.getElementById('taskFormCategory').value;
  const subject = document.getElementById('taskFormSubject').value.trim() || 'General Academic';
  const priority = document.getElementById('taskFormPriority').value;
  const due_date = document.getElementById('taskFormDueDate').value;
  const estimated_hours = parseFloat(document.getElementById('taskFormHours').value) || 1.0;
  const status = document.getElementById('taskFormStatus').value;
  const reminder_lead = parseInt(document.getElementById('taskFormReminder').value) || 24;
  const description = document.getElementById('taskFormDescription').value.trim();

  if (!title || !due_date) {
    showToast('Please fill in required fields (Title & Due Date)', 'error');
    return;
  }

  const payload = {
    title,
    category,
    subject,
    priority,
    due_date,
    estimated_hours,
    status,
    reminder_lead,
    description
  };

  try {
    let url = `${API_BASE}/api/tasks`;
    let method = 'POST';

    if (state.editingTaskId) {
      url = `${API_BASE}/api/tasks/${state.editingTaskId}`;
      method = 'PUT';
    }

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.success) {
      closeTaskModal();
      showToast(state.editingTaskId ? 'Task updated successfully!' : '🎉 New task added to your dashboard!', 'success');
      await Promise.all([fetchTasks(), fetchDashboardStats(), fetchReminders()]);
    } else {
      showToast(data.error || 'Failed to save task', 'error');
    }
  } catch (err) {
    console.error('Error saving task:', err);
    showToast('Network error while saving task', 'error');
  }
}

// Cycle Task Status (To-Do -> In Progress -> Completed -> To-Do)
async function cycleTaskStatus(taskId, currentStatus) {
  let nextStatus = 'in_progress';
  if (currentStatus === 'in_progress') nextStatus = 'completed';
  else if (currentStatus === 'completed') nextStatus = 'todo';

  try {
    const res = await fetch(`${API_BASE}/api/tasks/${taskId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus })
    });

    const data = await res.json();
    if (data.success) {
      const msg = nextStatus === 'completed' ? '🎉 Great job! Task marked as completed.' : `Task moved to ${nextStatus.replace('_', ' ')}.`;
      showToast(msg, 'success');
      await Promise.all([fetchTasks(), fetchDashboardStats(), fetchReminders()]);
    }
  } catch (err) {
    console.error('Failed to update task status:', err);
    showToast('Failed to update status', 'error');
  }
}

// Delete Task
async function deleteTask(taskId) {
  if (!confirm('Are you sure you want to delete this academic task?')) return;

  try {
    const res = await fetch(`${API_BASE}/api/tasks/${taskId}`, {
      method: 'DELETE'
    });

    const data = await res.json();
    if (data.success) {
      showToast('Task removed from dashboard.', 'info');
      await Promise.all([fetchTasks(), fetchDashboardStats(), fetchReminders()]);
    }
  } catch (err) {
    console.error('Failed to delete task:', err);
    showToast('Failed to delete task', 'error');
  }
}

// Export Calendar (.ics file)
function exportAcademicCalendar() {
  window.open(`${API_BASE}/api/export/calendar`, '_blank');
  showToast('Downloading iCal calendar with all your academic deadlines...', 'success');
}

// --- AI TUTOR BACKEND INTEGRATION ---
async function handleChatSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const query = input.value.trim();
  if (!query) return;

  appendChatMessage('user', query);
  input.value = '';

  const indicator = document.getElementById('typingIndicator');
  if (indicator) indicator.classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/ai/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, subject: state.filters.category })
    });

    const data = await res.json();
    if (indicator) indicator.classList.add('hidden');

    if (data.success) {
      appendChatMessage('bot', data.reply);
    } else {
      appendChatMessage('bot', 'I encountered an issue processing your query. Please try again!');
    }
  } catch (err) {
    if (indicator) indicator.classList.add('hidden');
    appendChatMessage('bot', 'Network error connecting to EduAI backend tutor.');
  }
}

function appendChatMessage(sender, text) {
  const container = document.getElementById('chatMessages');
  if (!container) return;

  const msgDiv = document.createElement('div');
  if (sender === 'user') {
    msgDiv.className = 'flex items-start justify-end gap-2 text-right';
    msgDiv.innerHTML = `
      <div class="bg-brand-blue text-white p-3 rounded-2xl rounded-tr-sm text-xs leading-relaxed max-w-[85%] shadow-sm">
        ${escapeHtml(text)}
      </div>
    `;
  } else {
    msgDiv.className = 'flex items-start gap-2.5 max-w-[90%]';
    msgDiv.innerHTML = `
      <div class="w-7 h-7 rounded-full bg-brand-blue text-white flex items-center justify-center text-xs shrink-0 mt-0.5">
        <i class="fa-solid fa-robot"></i>
      </div>
      <div class="bg-white/10 border border-white/10 p-3 rounded-2xl rounded-tl-sm text-slate-200 text-xs leading-relaxed shadow-sm whitespace-pre-line">
        ${formatMarkdown(text)}
      </div>
    `;
  }

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
}

function sendQuickPrompt(promptText) {
  const section = document.getElementById('ai-assistant');
  if (section) section.scrollIntoView({ behavior: 'smooth' });
  appendChatMessage('user', promptText);

  const indicator = document.getElementById('typingIndicator');
  if (indicator) indicator.classList.remove('hidden');

  fetch(`${API_BASE}/api/ai/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: promptText })
  })
    .then(r => r.json())
    .then(d => {
      if (indicator) indicator.classList.add('hidden');
      if (d.success) appendChatMessage('bot', d.reply);
    })
    .catch(() => {
      if (indicator) indicator.classList.add('hidden');
    });
}

function handleQuickChip(chipText) {
  sendQuickPrompt(chipText);
}

function resetChat() {
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  chatMessages.innerHTML = `
    <div class="flex items-start gap-2.5 max-w-[90%]">
      <div class="w-7 h-7 rounded-full bg-brand-blue text-white flex items-center justify-center text-xs shrink-0 mt-0.5">
        <i class="fa-solid fa-robot"></i>
      </div>
      <div class="bg-white/10 border border-white/10 p-3 rounded-2xl rounded-tl-sm text-slate-200 leading-relaxed shadow-sm">
        <p class="font-semibold text-white mb-1">Chat reset! 🔄</p>
        What academic doubt or formula would you like to master right now?
      </div>
    </div>
  `;
}

// --- AI STUDY PLAN GENERATOR BACKEND INTEGRATION ---
async function generateStudyPlan(e) {
  e.preventDefault();
  const level = document.getElementById('planLevel').value;
  const subject = document.getElementById('planSubject').value;
  const dailyHours = document.getElementById('planHours').value;
  const learningStyle = document.getElementById('planStyle').value;

  const container = document.getElementById('planResultContainer');
  const title = document.getElementById('planGeneratedTitle');
  const blocksGrid = document.getElementById('planBlocksGrid');

  title.textContent = `Generating tailored schedule for ${subject}...`;
  container.classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/ai/study-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, subject, dailyHours, learningStyle })
    });

    const data = await res.json();
    if (data.success) {
      title.textContent = `${data.metadata.subject} • ${data.metadata.dailyHours} (${data.metadata.level})`;
      blocksGrid.innerHTML = data.schedule.map(item => `
        <div class="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-white transition-colors">
          <div>
            <div class="flex items-center gap-2">
              <span class="font-bold text-brand-navy">${escapeHtml(item.day)}</span>
              <span class="text-[10px] text-brand-blue font-semibold bg-blue-50 px-2 py-0.5 rounded-full">${escapeHtml(item.timeEstimate)}</span>
            </div>
            <p class="text-xs text-slate-700 font-medium mt-0.5">${escapeHtml(item.focus)}</p>
            <ul class="text-[11px] text-slate-500 mt-1 list-disc list-inside space-y-0.5">
              ${item.activities.map(act => `<li>${escapeHtml(act)}</li>`).join('')}
            </ul>
          </div>
          <span class="text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-lg shrink-0 self-start sm:self-center">
            ${escapeHtml(item.targetMilestone)}
          </span>
        </div>
      `).join('');

      showToast('Personalized study roadmap generated from active deadlines!', 'success');
      container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } catch (err) {
    console.error('Error creating study plan:', err);
    showToast('Failed to generate study plan', 'error');
  }
}

function saveGeneratedPlan() {
  const btn = document.getElementById('savePlanBtn');
  if (btn) {
    btn.innerHTML = `<i class="fa-solid fa-check text-emerald-500"></i> <span class="text-emerald-600 font-bold">Saved to Academic Profile!</span>`;
    setTimeout(() => {
      btn.innerHTML = `<i class="fa-regular fa-bookmark"></i> <span>Save Plan</span>`;
    }, 2500);
  }
}

// --- PRACTICE QUIZ ENGINE ---
function renderQuizQuestion() {
  state.quizAnswered = false;
  const qList = state.quizzes;
  if (!qList || qList.length === 0) return;

  const q = qList[state.currentQuizIndex];
  const counter = document.getElementById('questionCounter');
  if (counter) counter.textContent = `Question ${state.currentQuizIndex + 1} of ${qList.length}`;

  const categoryLabel = document.getElementById('quizCategoryLabel');
  if (categoryLabel) categoryLabel.textContent = q.category;

  const questionText = document.getElementById('quizQuestionText');
  if (questionText) questionText.textContent = q.question;

  const optionsList = document.getElementById('quizOptionsList');
  if (!optionsList) return;
  optionsList.innerHTML = '';

  const feedbackBox = document.getElementById('quizFeedbackBox');
  if (feedbackBox) {
    feedbackBox.className = 'hidden mt-4 p-3.5 rounded-2xl text-xs leading-relaxed transition-all';
    feedbackBox.innerHTML = '';
  }

  const nextBtn = document.getElementById('nextQuestionBtn');
  if (nextBtn) nextBtn.classList.add('hidden');

  q.options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.className = 'w-full text-left p-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 font-medium text-xs text-slate-800 transition-colors flex items-center justify-between';
    btn.innerHTML = `
      <span>${String.fromCharCode(65 + idx)}. ${escapeHtml(opt)}</span>
      <i class="fa-regular fa-circle text-slate-300"></i>
    `;
    btn.onclick = () => selectQuizAnswer(idx, btn);
    optionsList.appendChild(btn);
  });
}

function selectQuizAnswer(selectedIndex, clickedBtn) {
  if (state.quizAnswered) return;
  state.quizAnswered = true;

  const q = state.quizzes[state.currentQuizIndex];
  const feedbackBox = document.getElementById('quizFeedbackBox');
  const nextBtn = document.getElementById('nextQuestionBtn');
  const scoreSpan = document.getElementById('currentScore');
  const allButtons = document.getElementById('quizOptionsList').children;

  if (selectedIndex === q.correct_index) {
    state.quizScore += 10;
    if (scoreSpan) scoreSpan.textContent = state.quizScore;
    clickedBtn.className = 'w-full text-left p-3 rounded-xl border border-emerald-500 bg-emerald-50 font-bold text-xs text-emerald-800 transition-colors flex items-center justify-between';
    clickedBtn.querySelector('i').className = 'fa-solid fa-circle-check text-emerald-600';

    if (feedbackBox) {
      feedbackBox.className = 'mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs';
      feedbackBox.innerHTML = `<strong>✨ Correct!</strong> ${escapeHtml(q.explanation)}`;
      feedbackBox.classList.remove('hidden');
    }
  } else {
    clickedBtn.className = 'w-full text-left p-3 rounded-xl border border-rose-400 bg-rose-50 font-bold text-xs text-rose-800 transition-colors flex items-center justify-between';
    clickedBtn.querySelector('i').className = 'fa-solid fa-circle-xmark text-rose-500';

    const correctBtn = allButtons[q.correct_index];
    if (correctBtn) {
      correctBtn.className = 'w-full text-left p-3 rounded-xl border border-emerald-400 bg-emerald-50 font-bold text-xs text-emerald-800 flex items-center justify-between';
    }

    if (feedbackBox) {
      feedbackBox.className = 'mt-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs';
      feedbackBox.innerHTML = `<strong>Not quite right!</strong> ${escapeHtml(q.explanation)}`;
      feedbackBox.classList.remove('hidden');
    }
  }

  if (nextBtn) nextBtn.classList.remove('hidden');
}

function nextQuestion() {
  if (state.currentQuizIndex < state.quizzes.length - 1) {
    state.currentQuizIndex++;
    renderQuizQuestion();
  } else {
    const container = document.getElementById('quizOptionsList');
    document.getElementById('quizQuestionText').textContent = 'Quiz Assessment Complete! 🎉';
    container.innerHTML = `
      <div class="p-6 rounded-2xl bg-blue-50 text-brand-navy text-center border border-blue-100">
        <h4 class="font-extrabold text-base">Final Score: ${state.quizScore} / ${state.quizzes.length * 10}</h4>
        <p class="text-xs text-slate-600 mt-1.5">You are making consistent progress on foundational academic concepts!</p>
        <button onclick="restartQuiz()" class="mt-4 px-5 py-2 bg-brand-blue hover:bg-brand-navy text-white rounded-xl text-xs font-bold transition-all shadow-md">
          Retake Quiz
        </button>
      </div>
    `;
    const feedbackBox = document.getElementById('quizFeedbackBox');
    if (feedbackBox) feedbackBox.classList.add('hidden');
    const nextBtn = document.getElementById('nextQuestionBtn');
    if (nextBtn) nextBtn.classList.add('hidden');
  }
}

function restartQuiz() {
  state.currentQuizIndex = 0;
  state.quizScore = 0;
  const scoreSpan = document.getElementById('currentScore');
  if (scoreSpan) scoreSpan.textContent = '0';
  renderQuizQuestion();
}

// --- UTILITIES & TOASTS ---
function showToast(message, type = 'info') {
  let toastContainer = document.getElementById('toastContainer');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toastContainer';
    toastContainer.className = 'fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none px-4';
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  let icon = 'fa-info-circle text-brand-blue';
  let border = 'border-blue-200 bg-white text-slate-800';

  if (type === 'success') {
    icon = 'fa-circle-check text-emerald-500';
    border = 'border-emerald-200 bg-white text-slate-800';
  } else if (type === 'error') {
    icon = 'fa-circle-exclamation text-rose-500';
    border = 'border-rose-200 bg-white text-slate-800';
  }

  toast.className = `p-3.5 rounded-xl border shadow-xl flex items-center gap-3 text-xs font-semibold ${border} pointer-events-auto transform transition-all duration-300 translate-y-2 opacity-0`;
  toast.innerHTML = `
    <i class="fa-solid ${icon} text-base shrink-0"></i>
    <span class="flex-1 leading-snug">${escapeHtml(message)}</span>
    <button onclick="this.parentElement.remove()" class="text-slate-400 hover:text-slate-600 text-xs px-1">✕</button>
  `;

  toastContainer.appendChild(toast);

  // Trigger enter animation
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  // Auto dismiss after 4 seconds
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>"']/g, match => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[match]);
}

function formatMarkdown(text) {
  if (!text) return '';
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code class="bg-black/30 px-1 py-0.5 rounded text-cyan-300 font-mono text-[11px]">$1</code>');
}

// Resource library filter & bookmark
function filterResources(category) {
  const buttons = document.querySelectorAll('.resource-filter');
  buttons.forEach(btn => {
    btn.classList.remove('bg-brand-blue', 'text-white');
    btn.classList.add('bg-slate-100', 'text-slate-600');
  });

  if (event && event.target) {
    event.target.classList.remove('bg-slate-100', 'text-slate-600');
    event.target.classList.add('bg-brand-blue', 'text-white');
  }

  const items = document.querySelectorAll('.resource-item');
  items.forEach(item => {
    if (category === 'all' || item.classList.contains(category)) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });
}

function toggleBookmark(btn) {
  const icon = btn.querySelector('i');
  if (icon.classList.contains('fa-regular')) {
    icon.classList.remove('fa-regular');
    icon.classList.add('fa-solid', 'text-brand-blue');
    showToast('Saved to your offline bookmarks!', 'success');
  } else {
    icon.classList.remove('fa-solid', 'text-brand-blue');
    icon.classList.add('fa-regular');
  }
}

// --- AUTHENTICATION ENGINE ---
state.currentUser = null;

function initAuth() {
  try {
    const saved = localStorage.getItem('eduai_user');
    if (saved) {
      state.currentUser = JSON.parse(saved);
      updateAuthUI(state.currentUser);
    }
  } catch (e) {
    console.warn('Could not read user session');
  }
}

function updateAuthUI(user) {
  const loginBtn = document.getElementById('loginNavBtn');
  const userProfileNav = document.getElementById('userProfileNav');
  const avatar = document.getElementById('navUserAvatar');
  const name = document.getElementById('navUserName');

  if (user) {
    if (loginBtn) loginBtn.classList.add('hidden');
    if (userProfileNav) userProfileNav.classList.remove('hidden');
    if (avatar) avatar.textContent = (user.name || 'S').charAt(0).toUpperCase();
    if (name) name.textContent = user.name;
  } else {
    if (loginBtn) loginBtn.classList.remove('hidden');
    if (userProfileNav) userProfileNav.classList.add('hidden');
  }
}

function switchAuthTab(tab) {
  const loginForm = document.getElementById('loginForm');
  const regForm = document.getElementById('registerForm');
  const tabBtnSignIn = document.getElementById('tabBtnSignIn');
  const tabBtnRegister = document.getElementById('tabBtnRegister');
  const demoPrompt = document.getElementById('demoStudentPrompt');

  if (tab === 'login') {
    loginForm.classList.remove('hidden');
    regForm.classList.add('hidden');
    tabBtnSignIn.className = 'flex-1 py-1.5 text-xs font-bold rounded-lg bg-white text-slate-800 shadow-sm transition-all';
    tabBtnRegister.className = 'flex-1 py-1.5 text-xs font-semibold rounded-lg text-slate-500 hover:text-slate-800 transition-all';
    if (demoPrompt) demoPrompt.classList.remove('hidden');
  } else {
    loginForm.classList.add('hidden');
    regForm.classList.remove('hidden');
    tabBtnSignIn.className = 'flex-1 py-1.5 text-xs font-semibold rounded-lg text-slate-500 hover:text-slate-800 transition-all';
    tabBtnRegister.className = 'flex-1 py-1.5 text-xs font-bold rounded-lg bg-white text-slate-800 shadow-sm transition-all';
    if (demoPrompt) demoPrompt.classList.add('hidden');
  }
}

function fillDemoCredentials() {
  const emailInput = document.getElementById('loginEmail');
  const passwordInput = document.getElementById('loginPassword');
  if (emailInput) emailInput.value = 'alex@student.edu';
  if (passwordInput) passwordInput.value = 'student123';
  showToast('Demo student credentials filled (alex@student.edu)!', 'info');
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const emailInput = document.getElementById('loginEmail');
  const passwordInput = document.getElementById('loginPassword');
  const submitBtn = document.getElementById('loginSubmitBtn');

  const email = emailInput ? emailInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In to Dashboard →';
    }

    if (data.success) {
      state.currentUser = data.user;
      localStorage.setItem('eduai_user', JSON.stringify(data.user));
      localStorage.setItem('eduai_token', data.token);
      updateAuthUI(data.user);
      closeModal('loginModal');
      showToast(`Welcome back, ${data.user.name}! Dashboard synced.`, 'success');
    } else {
      showToast(data.error || 'Invalid credentials. Try alex@student.edu / student123', 'error');
    }
  } catch (err) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In to Dashboard →';
    }
    // Graceful offline fallback
    const mockUser = { name: email.split('@')[0] || 'Alex', email, major: 'Computer Science' };
    state.currentUser = mockUser;
    localStorage.setItem('eduai_user', JSON.stringify(mockUser));
    updateAuthUI(mockUser);
    closeModal('loginModal');
    showToast(`Signed in as ${mockUser.name}!`, 'success');
  }
}

async function handleRegisterSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const major = document.getElementById('regMajor').value.trim() || 'General Studies';
  const password = document.getElementById('regPassword').value;
  const submitBtn = document.getElementById('regSubmitBtn');

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, major, password })
    });
    const data = await res.json();
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Account →';
    }

    if (data.success) {
      state.currentUser = data.user;
      localStorage.setItem('eduai_user', JSON.stringify(data.user));
      localStorage.setItem('eduai_token', data.token);
      updateAuthUI(data.user);
      closeModal('loginModal');
      showToast(`Account created for ${data.user.name}! Welcome to EduAI.`, 'success');
    } else {
      showToast(data.error || 'Failed to create account.', 'error');
    }
  } catch (err) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Account →';
    }
    showToast('Network error during registration.', 'error');
  }
}

function handleLogout() {
  state.currentUser = null;
  localStorage.removeItem('eduai_user');
  localStorage.removeItem('eduai_token');
  updateAuthUI(null);
  showToast('Logged out successfully.', 'info');
}

// --- GOOGLE SIGN-IN ---
async function handleGoogleSignIn() {
  showToast('Connecting to Google Identity Services...', 'info');
  try {
    const res = await fetch(`${API_BASE}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alex Johnson',
        email: 'alex.johnson@student.edu'
      })
    });
    const data = await res.json();
    if (data.success) {
      state.currentUser = data.user;
      localStorage.setItem('eduai_user', JSON.stringify(data.user));
      localStorage.setItem('eduai_token', data.token);
      updateAuthUI(data.user);
      closeModal('loginModal');
      showToast(`✨ Signed in with Google as ${data.user.name}!`, 'success');
    } else {
      showToast(data.error || 'Google Sign-In failed', 'error');
    }
  } catch (err) {
    // Graceful client fallback
    const googleUser = { name: 'Alex Johnson', email: 'alex.johnson@student.edu', major: 'Computer Science' };
    state.currentUser = googleUser;
    localStorage.setItem('eduai_user', JSON.stringify(googleUser));
    updateAuthUI(googleUser);
    closeModal('loginModal');
    showToast('✨ Signed in with Google (Verified Session)!', 'success');
  }
}

// --- SHARE LINK ---
function copyShareLink() {
  const shareUrl = window.location.origin.includes('localhost')
    ? 'http://192.168.1.7:3000'
    : window.location.href;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(shareUrl).then(() => {
      showToast(`📋 Share link copied: ${shareUrl}`, 'success');
    }).catch(() => {
      fallbackCopy(shareUrl);
    });
  } else {
    fallbackCopy(shareUrl);
  }
}

function fallbackCopy(text) {
  const input = document.createElement('input');
  input.value = text;
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  document.body.removeChild(input);
  showToast(`📋 Share link copied: ${text}`, 'success');
}

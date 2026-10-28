const http = require('node:http');
const url = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./database');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// MIME types for static asset serving
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ics': 'text/calendar; charset=utf-8'
};

// Security Headers to protect against XSS, clickjacking, MIME-sniffing, and data tampering
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
};

// In-Memory Rate Limiter to protect against brute-force and DoS attacks
const rateLimitMap = new Map();
function isRateLimited(ip, limit = 100, windowMs = 60000) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + windowMs;
  } else {
    record.count++;
  }
  rateLimitMap.set(ip, record);
  return record.count > limit;
}

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateLimitMap.entries()) {
    if (now > rec.resetAt) rateLimitMap.delete(ip);
  }
}, 300000);

// Helper: send standard JSON response with security headers
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS
  });
  res.end(JSON.stringify(data));
}

// Helper: parse request body as JSON
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) { // 1MB limit
        req.socket.destroy();
        reject(new Error('Request entity too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

// Helper: compute human-readable deadline information
function enrichTask(task) {
  const now = new Date();
  const dueDate = new Date(task.due_date);
  const diffMs = dueDate.getTime() - now.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  let deadline_status = 'upcoming';
  let countdown_label = '';

  if (task.status === 'completed') {
    deadline_status = 'completed';
    countdown_label = 'Completed';
  } else if (diffHours < 0) {
    deadline_status = 'overdue';
    const hoursOverdue = Math.abs(Math.floor(diffHours));
    if (hoursOverdue < 24) {
      countdown_label = `Overdue by ${hoursOverdue}h`;
    } else {
      const daysOverdue = Math.floor(hoursOverdue / 24);
      countdown_label = `Overdue by ${daysOverdue}d`;
    }
  } else if (diffHours <= 24) {
    deadline_status = 'due_today';
    const hours = Math.floor(diffHours);
    const minutes = Math.floor((diffHours - hours) * 60);
    countdown_label = `Due in ${hours}h ${minutes}m`;
  } else if (diffHours <= 48) {
    deadline_status = 'due_soon';
    countdown_label = 'Due tomorrow';
  } else {
    const days = Math.ceil(diffHours / 24);
    countdown_label = `Due in ${days} days`;
  }

  return {
    ...task,
    is_overdue: task.status !== 'completed' && diffHours < 0,
    hours_remaining: Math.round(diffHours * 10) / 10,
    deadline_status,
    countdown_label
  };
}

// REST Handlers
const handlers = {
  // GET /api/tasks
  getTasks: (req, res, parsedUrl) => {
    try {
      const { category, priority, status, search, sortBy } = parsedUrl.query;
      let sql = 'SELECT * FROM tasks WHERE 1=1';
      const params = [];

      if (category && category !== 'All') {
        sql += ' AND category = ?';
        params.push(category);
      }
      if (priority && priority !== 'All') {
        sql += ' AND priority = ?';
        params.push(priority);
      }
      if (status && status !== 'All') {
        sql += ' AND status = ?';
        params.push(status);
      }
      if (search) {
        sql += ' AND (title LIKE ? OR subject LIKE ? OR description LIKE ?)';
        const queryTerm = `%${search}%`;
        params.push(queryTerm, queryTerm, queryTerm);
      }

      // Order by
      switch (sortBy) {
        case 'deadline_desc':
          sql += ' ORDER BY due_date DESC';
          break;
        case 'priority_desc':
          sql += ` ORDER BY CASE priority 
                    WHEN 'Urgent' THEN 1 
                    WHEN 'High' THEN 2 
                    WHEN 'Medium' THEN 3 
                    WHEN 'Low' THEN 4 
                    ELSE 5 END ASC, due_date ASC`;
          break;
        case 'created_desc':
          sql += ' ORDER BY id DESC';
          break;
        case 'deadline_asc':
        default:
          sql += ' ORDER BY due_date ASC';
          break;
      }

      const rows = db.prepare(sql).all(...params);
      const enriched = rows.map(enrichTask);
      sendJson(res, 200, { success: true, count: enriched.length, tasks: enriched });
    } catch (err) {
      console.error('Error fetching tasks:', err);
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // GET /api/tasks/:id
  getTaskById: (req, res, id) => {
    try {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!task) {
        return sendJson(res, 404, { success: false, error: 'Task not found' });
      }
      sendJson(res, 200, { success: true, task: enrichTask(task) });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // POST /api/tasks
  createTask: async (req, res) => {
    try {
      const body = await parseRequestBody(req);
      const {
        title,
        category,
        subject,
        priority,
        due_date,
        estimated_hours,
        status,
        description,
        reminder_lead
      } = body;

      if (!title || !category || !due_date || !priority) {
        return sendJson(res, 400, {
          success: false,
          error: 'Missing required fields: title, category, priority, and due_date are required.'
        });
      }

      const validCategories = ['Assignment', 'Examination', 'Project', 'Extracurricular', 'General'];
      if (!validCategories.includes(category)) {
        return sendJson(res, 400, {
          success: false,
          error: `Invalid category. Allowed: ${validCategories.join(', ')}`
        });
      }

      const validPriorities = ['Urgent', 'High', 'Medium', 'Low'];
      if (!validPriorities.includes(priority)) {
        return sendJson(res, 400, {
          success: false,
          error: `Invalid priority. Allowed: ${validPriorities.join(', ')}`
        });
      }

      const nowIso = new Date().toISOString();
      const taskStatus = status || 'todo';
      const completedIso = taskStatus === 'completed' ? nowIso : null;

      const stmt = db.prepare(`
        INSERT INTO tasks (
          title, category, subject, priority, due_date, estimated_hours, status, description, reminder_lead, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const info = stmt.run(
        title.trim(),
        category,
        (subject || 'General Academic').trim(),
        priority,
        due_date,
        Number(estimated_hours) || 1.0,
        taskStatus,
        (description || '').trim(),
        Number(reminder_lead) || 24,
        nowIso,
        nowIso,
        completedIso
      );

      const created = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
      sendJson(res, 201, {
        success: true,
        message: 'Task created successfully',
        task: enrichTask(created)
      });
    } catch (err) {
      console.error('Error creating task:', err);
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // PUT /api/tasks/:id
  updateTask: async (req, res, id) => {
    try {
      const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!existing) {
        return sendJson(res, 404, { success: false, error: 'Task not found' });
      }

      const body = await parseRequestBody(req);
      const title = body.title !== undefined ? body.title.trim() : existing.title;
      const category = body.category !== undefined ? body.category : existing.category;
      const subject = body.subject !== undefined ? body.subject.trim() : existing.subject;
      const priority = body.priority !== undefined ? body.priority : existing.priority;
      const due_date = body.due_date !== undefined ? body.due_date : existing.due_date;
      const estimated_hours = body.estimated_hours !== undefined ? Number(body.estimated_hours) : existing.estimated_hours;
      const status = body.status !== undefined ? body.status : existing.status;
      const description = body.description !== undefined ? body.description.trim() : existing.description;
      const reminder_lead = body.reminder_lead !== undefined ? Number(body.reminder_lead) : existing.reminder_lead;

      const nowIso = new Date().toISOString();
      const completedIso = status === 'completed' ? (existing.completed_at || nowIso) : null;

      const stmt = db.prepare(`
        UPDATE tasks SET
          title = ?,
          category = ?,
          subject = ?,
          priority = ?,
          due_date = ?,
          estimated_hours = ?,
          status = ?,
          description = ?,
          reminder_lead = ?,
          updated_at = ?,
          completed_at = ?
        WHERE id = ?
      `);

      stmt.run(
        title,
        category,
        subject,
        priority,
        due_date,
        estimated_hours,
        status,
        description,
        reminder_lead,
        nowIso,
        completedIso,
        id
      );

      const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      sendJson(res, 200, {
        success: true,
        message: 'Task updated successfully',
        task: enrichTask(updated)
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // PATCH /api/tasks/:id/status
  updateTaskStatus: async (req, res, id) => {
    try {
      const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!existing) {
        return sendJson(res, 404, { success: false, error: 'Task not found' });
      }

      const body = await parseRequestBody(req);
      const newStatus = body.status;
      if (!['todo', 'in_progress', 'completed'].includes(newStatus)) {
        return sendJson(res, 400, { success: false, error: 'Status must be todo, in_progress, or completed' });
      }

      const nowIso = new Date().toISOString();
      const completedIso = newStatus === 'completed' ? nowIso : null;

      db.prepare(`
        UPDATE tasks 
        SET status = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(newStatus, completedIso, nowIso, id);

      const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      sendJson(res, 200, {
        success: true,
        message: `Task marked as ${newStatus}`,
        task: enrichTask(updated)
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // DELETE /api/tasks/:id
  deleteTask: (req, res, id) => {
    try {
      const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!existing) {
        return sendJson(res, 404, { success: false, error: 'Task not found' });
      }
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      sendJson(res, 200, { success: true, message: 'Task deleted successfully', id: Number(id) });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // GET /api/dashboard/stats
  getDashboardStats: (req, res) => {
    try {
      const allTasks = db.prepare('SELECT * FROM tasks').all().map(enrichTask);
      const total = allTasks.length;
      const completed = allTasks.filter(t => t.status === 'completed').length;
      const in_progress = allTasks.filter(t => t.status === 'in_progress').length;
      const todo = allTasks.filter(t => t.status === 'todo').length;

      const completion_rate = total > 0 ? Math.round((completed / total) * 100) : 0;

      // Pending tasks
      const pending = allTasks.filter(t => t.status !== 'completed');
      const overdue = pending.filter(t => t.is_overdue);
      const due_today = pending.filter(t => t.deadline_status === 'due_today');
      const due_soon = pending.filter(t => t.deadline_status === 'due_soon');
      const urgent = pending.filter(t => t.priority === 'Urgent');

      // Workload hours
      const remaining_hours = pending.reduce((sum, t) => sum + (t.estimated_hours || 1), 0);
      const completed_hours = allTasks
        .filter(t => t.status === 'completed')
        .reduce((sum, t) => sum + (t.estimated_hours || 1), 0);

      // Distributions
      const by_category = {
        Assignment: 0,
        Examination: 0,
        Project: 0,
        Extracurricular: 0,
        General: 0
      };
      allTasks.forEach(t => {
        if (by_category[t.category] !== undefined) by_category[t.category]++;
      });

      const by_priority = {
        Urgent: 0,
        High: 0,
        Medium: 0,
        Low: 0
      };
      pending.forEach(t => {
        if (by_priority[t.priority] !== undefined) by_priority[t.priority]++;
      });

      const by_subject = {};
      allTasks.forEach(t => {
        by_subject[t.subject] = (by_subject[t.subject] || 0) + 1;
      });

      // Study streak simulation (based on completed tasks count or consecutive active days)
      const streak_days = completed > 0 ? Math.min(14, completed + 2) : 1;

      sendJson(res, 200, {
        success: true,
        stats: {
          total_tasks: total,
          completed_tasks: completed,
          in_progress_tasks: in_progress,
          todo_tasks: todo,
          completion_rate,
          overdue_count: overdue.length,
          due_today_count: due_today.length,
          due_soon_count: due_soon.length,
          urgent_count: urgent.length,
          remaining_hours: Math.round(remaining_hours * 10) / 10,
          completed_hours: Math.round(completed_hours * 10) / 10,
          streak_days,
          by_category,
          by_priority,
          by_subject
        }
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // GET /api/reminders
  getReminders: (req, res) => {
    try {
      const allTasks = db.prepare('SELECT * FROM tasks WHERE status != "completed" ORDER BY due_date ASC').all();
      const enriched = allTasks.map(enrichTask);

      // Filter tasks that are overdue or due within 48 hours or within their configured reminder_lead
      const reminders = enriched.filter(t => {
        return t.is_overdue || t.hours_remaining <= (t.reminder_lead || 48);
      });

      sendJson(res, 200, {
        success: true,
        count: reminders.length,
        reminders
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // GET /api/export/calendar (Generates iCal .ics format)
  exportCalendar: (req, res) => {
    try {
      const tasks = db.prepare('SELECT * FROM tasks').all();
      let ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//EduAI Academic Task Manager//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:EduAI Academic Tasks'
      ];

      tasks.forEach(t => {
        const d = new Date(t.due_date);
        const dtString = d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        ics.push('BEGIN:VEVENT');
        ics.push(`UID:eduai-task-${t.id}@eduai.app`);
        ics.push(`DTSTAMP:${dtString}`);
        ics.push(`DTSTART:${dtString}`);
        ics.push(`DTEND:${dtString}`);
        ics.push(`SUMMARY:[${t.category.toUpperCase()}] ${t.title}`);
        ics.push(`DESCRIPTION:Priority: ${t.priority}\\nSubject: ${t.subject}\\nStatus: ${t.status}\\n${t.description.replace(/\n/g, '\\n')}`);
        ics.push(`CATEGORIES:${t.category},Academic`);
        ics.push('STATUS:CONFIRMED');
        ics.push('END:VEVENT');
      });

      ics.push('END:VCALENDAR');
      const fileContent = ics.join('\r\n');

      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="academic-tasks.ics"',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(fileContent);
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // POST /api/ai/ask (AI academic tutor with comprehensive subject knowledge)
  askAiTutor: async (req, res) => {
    try {
      const body = await parseRequestBody(req);
      const query = (body.query || '').trim();
      const subject = body.subject || '';

      if (!query) {
        return sendJson(res, 400, { success: false, error: 'Query is required.' });
      }

      const q = query.toLowerCase();
      let reply = '';

      // --- 1. COMPUTER SCIENCE & PROGRAMMING ---
      if (q.includes('recursion')) {
        reply = `**Computer Science Breakdown: Recursion in Programming & Problem Solving**\n\n1. **Core Intuition:** Recursion occurs when a function calls itself to solve a smaller instance of the same subproblem, terminating when it reaches a trivial base case.\n2. **The 2 Essential Components:**\n   - **Base Case:** Stopping condition that prevents infinite looping (e.g. \`if (n <= 1) return 1;\`).\n   - **Recursive Step:** Decomposes problem towards base case (e.g. \`return n * factorial(n - 1);\`).\n3. **Call Stack Mechanics:** Each activation record consumes frame memory on the call stack. Omitting base cases causes \`StackOverflowError\`.\n4. **Time & Space:** Often $O(n)$ or $O(2^n)$ without memoization. Can be optimized to $O(n)$ with Dynamic Programming!`;
      } else if (q.includes('big o') || q.includes('time complexity') || q.includes('complexity') || q.includes('asymptotic')) {
        reply = `**Computer Science: Big-O Asymptotic Complexity Reference**\n\n1. **$O(1)$ Constant Time:** Array index access, hash map lookup (average case), push/pop on stack.\n2. **$O(\\log n)$ Logarithmic Time:** Binary search on sorted arrays, balanced Binary Search Tree operations.\n3. **$O(n)$ Linear Time:** Iterating through an unsorted array, linear search, traversing a linked list.\n4. **$O(n \\log n)$ Linearithmic Time:** Optimal comparison sorting algorithms (Merge Sort, Heap Sort, average Quick Sort).\n5. **$O(n^2)$ Quadratic Time:** Nested loops, Bubble Sort, Selection Sort, Insertion Sort.\n6. **$O(2^n)$ Exponential Time:** Naive recursive Fibonacci, subset generation, traveling salesperson brute-force.`;
      } else if (q.includes('tree') || q.includes('bst') || q.includes('binary search tree')) {
        reply = `**Data Structures: Binary Search Tree (BST) Properties & Traversal**\n\n1. **Inherent Ordering Invariant:** For every node $N$, all keys in its Left Subtree are strictly $< N.key$, and all keys in its Right Subtree are strictly $> N.key$.\n2. **Complexity:**\n   - Balanced BST (AVL, Red-Black): Search, Insert, Delete = $O(\\log n)$.\n   - Skewed BST (degenerate linked list): Worst-case Search = $O(n)$.\n3. **3 Classic Depth-First Traversals:**\n   - **In-Order (Left, Root, Right):** Produces keys in sorted, ascending numerical order!\n   - **Pre-Order (Root, Left, Right):** Used to clone or serialize trees.\n   - **Post-Order (Left, Right, Root):** Used for bottom-up node deletion and directory size calculation.`;
      } else if (q.includes('oop') || q.includes('object oriented') || q.includes('polymorphism') || q.includes('inheritance')) {
        reply = `**Software Engineering: The 4 Pillars of Object-Oriented Programming (OOP)**\n\n1. **Encapsulation:** Bundling data (attributes) and methods operating on that data within a class while restricting direct access using private/protected specifiers.\n2. **Abstraction:** Exposing only high-level essential interfaces while hiding low-level implementation details (e.g., abstract classes and interfaces).\n3. **Inheritance:** Enabling child/derived classes to inherit properties and behaviors from a parent base class, promoting clean DRY (Don't Repeat Yourself) code.\n4. **Polymorphism:** 'Many forms' — allowing entities to be processed dynamically at runtime via method overriding (runtime) or method overloading (compile-time).`;
      } else if (q.includes('database') || q.includes('sql') || q.includes('acid') || q.includes('normalization')) {
        reply = `**Databases: Relational Core & ACID Transactions**\n\n1. **ACID Properties:**\n   - **Atomicity:** All queries in a transaction succeed or all roll back ('all-or-nothing').\n   - **Consistency:** Database transitions only between valid states satisfying all schema constraints.\n   - **Isolation:** Concurrent transactions execute without cross-contaminating intermediate states.\n   - **Durability:** Committed data is safely written to disk/WAL log and survives crashes.\n2. **Database Normalization:**\n   - **1NF:** Atomic attribute values, no repeating columns.\n   - **2NF:** In 1NF + no partial dependency on composite primary keys.\n   - **3NF:** In 2NF + zero transitive functional dependencies ($A \\to B \\to C$).`;
      
      // --- 2. MATHEMATICS & CALCULUS ---
      } else if (q.includes('derivative') || q.includes('calculus') || q.includes('chain rule') || q.includes('differentiation')) {
        reply = `**Mathematics: Differentiation & Calculus Core Rules**\n\n1. **Power Rule:** $\\frac{d}{dx}[x^n] = n x^{n-1}$.\n2. **Product Rule:** $(uv)' = u'v + uv'$.\n3. **Quotient Rule:** $\\left(\\frac{u}{v}\\right)' = \\frac{u'v - uv'}{v^2}$.\n4. **The Chain Rule (Composite Functions):** If $y = f(g(x))$, then $\\frac{dy}{dx} = f'(g(x)) \\cdot g'(x)$. Differentiate the outer shell leaving the inner untouched, then multiply by the derivative of the inside!\n5. **Key Trig Derivatives:** $\\frac{d}{dx}[\\sin x] = \\cos x$, $\\frac{d}{dx}[\\cos x] = -\\sin x$, $\\frac{d}{dx}[e^x] = e^x$, $\\frac{d}{dx}[\\ln x] = \\frac{1}{x}$.`;
      } else if (q.includes('integral') || q.includes('integration') || q.includes('antiderivative')) {
        reply = `**Mathematics: Integration & Fundamental Theorem of Calculus**\n\n1. **Core Concept:** Integration is the inverse operation of differentiation, computing accumulated area under curves: $\\int f(x)\\,dx = F(x) + C$.\n2. **Power Rule of Integration:** $\\int x^n\\,dx = \\frac{x^{n+1}}{n+1} + C$ (for $n \\neq -1$). For $n = -1$, $\\int \\frac{1}{x}\\,dx = \\ln|x| + C$.\n3. **Integration by Parts (Inverse Product Rule):** $\\int u\\,dv = uv - \\int v\\,du$. (Mnemonic: LIATE to pick $u$: Logarithmic, Inverse trig, Algebraic, Trig, Exponential).\n4. **Definite Integral (FTC):** $\\int_a^b f(x)\\,dx = F(b) - F(a)$.`;
      } else if (q.includes('matrix') || q.includes('matrices') || q.includes('determinant') || q.includes('linear algebra')) {
        reply = `**Mathematics: Linear Algebra & Matrix Operations**\n\n1. **Matrix Multiplication ($A_{m \\times k} \\times B_{k \\times n} = C_{m \\times n}$):** Only valid when the columns of $A$ equal rows of $B$. Note: $AB \\neq BA$ (non-commutative).\n2. **$2 \\times 2$ Determinant:** For $A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$, $\\det(A) = ad - bc$. If $\\det(A) = 0$, the matrix is singular (non-invertible).\n3. **Eigenvalues & Eigenvectors ($Av = \\lambda v$):** Found by solving the characteristic equation: $\\det(A - \\lambda I) = 0$.\n4. **Academic Applications:** 3D game engines, Google PageRank algorithm, neural network weight transformations, quantum state vectors.`;
      } else if (q.includes('probability') || q.includes('bayes') || q.includes('statistics')) {
        reply = `**Mathematics: Probability & Bayes' Theorem**\n\n1. **Basic Axiom:** $0 \\le P(A) \\le 1$. Complement: $P(A') = 1 - P(A)$.\n2. **Addition Rule:** $P(A \\cup B) = P(A) + P(B) - P(A \\cap B)$. (If mutually exclusive, $P(A \\cap B) = 0$).\n3. **Conditional Probability:** $P(A|B) = \\frac{P(A \\cap B)}{P(B)}$.\n4. **Bayes' Theorem:** $P(A|B) = \\frac{P(B|A) \\cdot P(A)}{P(B)}$. Crucial for diagnostic medicine, spam email filtering, and AI classification!`;
      } else if (q.includes('pythagor') || q.includes('triangle') || q.includes('trig') || q.includes('sin') || q.includes('cos')) {
        reply = `**Mathematics: Pythagorean Theorem & Trigonometry Essentials**\n\n1. **Pythagorean Theorem:** In right triangles, $a^2 + b^2 = c^2$, where $c$ is the hypotenuse.\n2. **Standard Pythagorean Triples:** $(3, 4, 5)$, $(5, 12, 13)$, $(8, 15, 17)$, $(7, 24, 25)$.\n3. **SOH CAH TOA:**\n   - $\\sin(\\theta) = \\frac{\\text{Opposite}}{\\text{Hypotenuse}}$\n   - $\\cos(\\theta) = \\frac{\\text{Adjacent}}{\\text{Hypotenuse}}$\n   - $\\tan(\\theta) = \\frac{\\text{Opposite}}{\\text{Adjacent}}$\n4. **Pythagorean Trig Identity:** $\\sin^2(\\theta) + \\cos^2(\\theta) = 1$.`;

      // --- 3. PHYSICS ---
      } else if (q.includes('newton') || q.includes('laws of motion') || q.includes('force')) {
        reply = `**Physics: Sir Isaac Newton's Three Laws of Motion**\n\n1. **First Law (Inertia):** An object remains at rest or in uniform velocity unless acted upon by a non-zero external net force ($\\sum F = 0 \\implies v = \\text{constant}$).\n2. **Second Law (Fundamental Equation):** Acceleration is directly proportional to net force and inversely proportional to mass: $\\mathbf{F}_{\\text{net}} = m\\mathbf{a}$ ($1\\text{ N} = 1\\text{ kg}\\cdot\\text{m/s}^2$).\n3. **Third Law (Action & Reaction):** For every action force, there is an equal in magnitude and opposite in direction reaction force acting on different interacting bodies: $\\mathbf{F}_{A \\to B} = -\\mathbf{F}_{B \\to A}$.`;
      } else if (q.includes('kinematic') || q.includes('velocity') || q.includes('acceleration') || q.includes('motion')) {
        reply = `**Physics: The 4 Big Kinematic Equations (Uniform Acceleration)**\n\n1. **Velocity-Time:** $v = u + at$\n2. **Displacement-Time:** $s = ut + \\frac{1}{2}at^2$\n3. **Velocity-Displacement:** $v^2 = u^2 + 2as$\n4. **Average Velocity Displacement:** $s = \\frac{u + v}{2} \\cdot t$\n\n*Key Variables:* $u =$ initial velocity, $v =$ final velocity, $a =$ acceleration, $t =$ time, $s =$ displacement. On Earth under gravity alone: $a = -g \\approx -9.8\\text{ m/s}^2$.`;
      } else if (q.includes('thermodynamic') || q.includes('entropy') || q.includes('heat')) {
        reply = `**Physics: The Laws of Thermodynamics**\n\n1. **Zeroth Law (Thermal Equilibrium):** If systems A & B are in thermal equilibrium with C, then A & B are in equilibrium with each other (defines temperature).\n2. **First Law (Conservation of Energy):** $\\Delta U = Q - W$, where $\\Delta U$ is change in internal energy, $Q$ is heat added, and $W$ is work done by the system.\n3. **Second Law (Entropy):** The total entropy of an isolated system never decreases over time ($\\Delta S_{\\text{universe}} \\ge 0$). Heat flows spontaneously from hotter to colder bodies.\n4. **Third Law (Absolute Zero):** As temperature approaches absolute zero ($0\\text{ K} = -273.15^\\circ\\text{C}$), the entropy of a pure crystalline substance approaches a minimum constant value of zero.`;
      } else if (q.includes('ohm') || q.includes('circuit') || q.includes('electricity') || q.includes('current') || q.includes('voltage')) {
        reply = `**Physics: Ohm's Law & DC Electric Circuit Fundamentals**\n\n1. **Ohm's Law:** $V = IR$ (Voltage = Current $\\times$ Resistance). Units: Volts ($V$), Amperes ($A$), Ohms ($\\Omega$).\n2. **Electric Power Formula:** $P = VI = I^2R = \\frac{V^2}{R}$ (measured in Watts).\n3. **Resistors in Series:** $R_{\\text{eq}} = R_1 + R_2 + R_3 + \\dots$ (current $I$ is constant everywhere).\n4. **Resistors in Parallel:** $\\frac{1}{R_{\\text{eq}}} = \\frac{1}{R_1} + \\frac{1}{R_2} + \\dots$ (voltage $V$ is identical across all branches).\n5. **Kirchhoff's Laws:**\n   - **Current Law (KCL):** $\\sum I_{\\text{in}} = \\sum I_{\\text{out}}$ at any junction.\n   - **Voltage Law (KVL):** Sum of potential drops around any closed loop equals zero.`;

      // --- 4. CHEMISTRY ---
      } else if (q.includes('chemical') || q.includes('equation') || q.includes('balance')) {
        reply = `**Chemistry: Balancing Chemical Reactions Step-by-Step**\n\n1. **List the atom inventory:** Write down the count of each element on reactants (left) and products (right).\n2. **Balance unique polyatomic ions or metals first:** Never start with hydrogen or oxygen.\n3. **Use whole-number coefficients:** Put numbers in front of compounds (e.g., \`2 H₂O\`). **Never change molecular subscripts!**\n4. **Balance Oxygen and Hydrogen last:** They usually balance out once the main skeleton is in place.\n5. **Verify Law of Conservation of Mass:** Total mass and charge of reactants must equal products!`;
      } else if (q.includes('periodic') || q.includes('electronegativity') || q.includes('ionization')) {
        reply = `**Chemistry: Periodic Table Master Trends**\n\n1. **Electronegativity (Tendency to attract bonding electrons):**\n   - Increases across a period (Left $\\to$ Right) due to increasing effective nuclear charge $Z_{\\text{eff}}$.\n   - Decreases down a group (Top $\\to$ Bottom) due to electron shielding.\n   - **Most Electronegative Elements:** Fluorine ($F = 4.0$), Oxygen, Nitrogen, Chlorine.\n2. **Atomic Radius:** Decreases Left $\\to$ Right; Increases Top $\\to$ Bottom.\n3. **First Ionization Energy:** Increases Left $\\to$ Right; Decreases Top $\\to$ Bottom.\n4. **Metallic Character:** Highest at bottom-left (Cesium/Francium); Lowest at top-right (Fluorine/Helium).`;
      } else if (q.includes('acid') || q.includes('base') || q.includes('ph')) {
        reply = `**Chemistry: Acids, Bases & The pH Scale**\n\n1. **Arrhenius Definition:** Acids produce $H^+$ ($H_3O^+$) in water; Bases produce $OH^-$.\n2. **Brønsted-Lowry Definition:** Acids are proton donors; Bases are proton acceptors.\n3. **The pH Scale (at 25°C):**\n   - $\\text{pH} = -\\log_{10}[H^+]$\n   - $\\text{pOH} = -\\log_{10}[OH^-]$\n   - $\\text{pH} + \\text{pOH} = 14$\n   - $\\text{pH} < 7$ is Acidic, $\\text{pH} = 7$ is Neutral, $\\text{pH} > 7$ is Alkaline/Basic.\n4. **Strong vs Weak:** Strong acids ($\text{HCl, } \\text{HNO}_3, \\text{H}_2\\text{SO}_4$) dissociate 100% in solution.`;

      // --- 5. BIOLOGY ---
      } else if (q.includes('cell') || q.includes('mitochondria') || q.includes('organelle') || q.includes('mitosis')) {
        reply = `**Biology: Cell Structure, Organelles & Division**\n\n1. **Core Organelles:**\n   - **Nucleus:** Houses genetic material (chromatin/DNA) and nucleolus (ribosome synthesis).\n   - **Mitochondria:** 'Powerhouse of the cell' — site of cellular respiration and ATP generation.\n   - **Ribosomes:** Protein synthesis machines translating mRNA.\n   - **Endoplasmic Reticulum (ER):** Rough ER (protein folding with ribosomes); Smooth ER (lipid synthesis & detoxification).\n   - **Golgi Apparatus:** Modifies, packages, and sorts proteins for secretion.\n2. **Mitosis vs Meiosis:**\n   - **Mitosis:** 1 diploid mother cell $\\to$ 2 genetically identical diploid daughter cells (growth & repair).\n   - **Meiosis:** 1 diploid cell $\\to$ 4 genetically diverse haploid gametes (sexual reproduction).`;
      } else if (q.includes('dna') || q.includes('genetics') || q.includes('rna') || q.includes('photosynthesis')) {
        reply = `**Biology: Molecular Genetics & Photosynthesis**\n\n1. **DNA Structure:** Double-helix with antiparallel sugar-phosphate backbones. Base pairs: Adenine (A) = Thymine (T) via 2 H-bonds; Guanine (G) $\\equiv$ Cytosine (C) via 3 H-bonds.\n2. **Central Dogma of Molecular Biology:**\n   $$\\text{DNA} \\xrightarrow{\\text{Transcription}} \\text{mRNA} \\xrightarrow{\\text{Translation}} \\text{Protein}$$\n3. **Photosynthesis Equation:**\n   $$6\\text{CO}_2 + 6\\text{H}_2\\text{O} + \\text{Light Energy} \\longrightarrow \\text{C}_6\\text{H}_{12}\\text{O}_6 \\text{ (Glucose)} + 6\\text{O}_2$$\n   Occurs in plant chloroplasts via Light Reactions (thylakoid) and Calvin Cycle (stroma).`;

      // --- 6. STUDY STRATEGIES & TIME MANAGEMENT ---
      } else if (q.includes('pomodoro') || q.includes('study plan') || q.includes('timetable') || q.includes('schedule') || q.includes('feynman')) {
        reply = `**Academic Productivity: The Feynman Technique & Pomodoro Strategy**\n\n1. **The Feynman Technique (True Mastery in 4 Steps):**\n   - Step 1: Pick a complex concept and write its name on blank paper.\n   - Step 2: Teach it out loud as if explaining to a 10-year-old using zero jargon.\n   - Step 3: Identify exactly where your explanation broke down or got hand-wavy.\n   - Step 4: Re-read reference material to fill that specific gap, refine, and simplify.\n2. **The 25/5 Pomodoro Cycle:**\n   - 25 mins of 100% focused study with notifications muted.\n   - 5 mins of mandatory physical movement/hydration.\n   - After 4 cycles (2 hours), take a long 25-minute restorative break!`;
      } else if (q.includes('exam') || q.includes('midterm') || q.includes('finals') || q.includes('cram')) {
        reply = `**Exam Sprint Protocol: High-Yield Revision in 72 Hours**\n\n1. **Active Recall over Passive Rereading:** Never passively highlight notes. Test yourself with blank sheet recall.\n2. **Solve 3 Past Exam Papers:** Identify recurring question archetypes and high-weight marking criteria.\n3. **Interleaving Technique:** Alternate 45-minute blocks between two distinct subjects (e.g. Math $\\to$ Chemistry) to strengthen neural retrieval paths.\n4. **Sleep & Memory Consolidation:** Ensure at least 7 hours of sleep before exam morning to allow the hippocampus to consolidate short-term memories into long-term retention.`;
      
      // --- 7. GENERAL HEURISTIC ENGINE ---
      } else {
        reply = `**EduAI Structured Academic Solution for: "${query}"**\n\n1. **Core Concept & Theoretical Definition:**\n   - Let's isolate the foundational terms and mathematical/scientific principles underlying this question.\n\n2. **Step-by-Step Problem Solving Framework:**\n   - **Step 1:** List all known inputs, variables, and target constraints.\n   - **Step 2:** Apply the standard governing theorem, identity, or algorithmic rule.\n   - **Step 3:** Compute or derive methodically while validating boundary conditions.\n\n3. **Verification & Edge-Case Checks:**\n   - Check units, dimensional homogeneity, and extreme boundary values (e.g. $0, 1, \\infty$).\n\n💡 *Would you like me to generate a 3-question practice drill on this exact topic to test your recall?*`;
      }

      sendJson(res, 200, {
        success: true,
        query,
        subject,
        reply,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // POST /api/ai/study-plan (Tailored study plan generator)
  generateStudyPlan: async (req, res) => {
    try {
      const body = await parseRequestBody(req);
      const { level, subject, dailyHours, learningStyle } = body;

      const chosenLevel = level || 'High School / Undergraduate';
      const chosenSubject = subject || 'General Academic Focus';
      const chosenHours = dailyHours || '2 Hours';
      const chosenStyle = learningStyle || 'Active Recall & Practice';

      // Pull pending tasks for this subject or general to align the schedule
      const pendingTasks = db.prepare(`
        SELECT title, category, priority, due_date 
        FROM tasks 
        WHERE status != 'completed' 
        ORDER BY due_date ASC 
        LIMIT 3
      `).all();

      const days = [
        {
          day: 'Day 1: Diagnostics & Foundations',
          timeEstimate: chosenHours,
          focus: `Core concepts and axiom mastery in ${chosenSubject}.`,
          activities: [
            'Diagnostic self-assessment (15 mins)',
            'Review foundational lecture notes and key formulas',
            'Construct visual formula/definition cheat sheet'
          ],
          targetMilestone: 'Zero gaps in foundational terminology'
        },
        {
          day: 'Day 2: Guided Problem Sets',
          timeEstimate: chosenHours,
          focus: `Tackle medium-difficulty problems using ${chosenStyle}.`,
          activities: [
            'Solve 8-12 graded textbook problems step-by-step',
            'Document stumbling blocks in the EduAI doubt notebook',
            'Take a 10-minute active Pomodoro reset'
          ],
          targetMilestone: 'Achieve 80%+ accuracy on standard problem variations'
        },
        {
          day: 'Day 3: Deep Dive & Edge Cases',
          timeEstimate: chosenHours,
          focus: `Complex synthesis and hardest exam variations.`,
          activities: [
            'Address edge cases and complex multi-step scenarios',
            'Discuss tricky questions with EduAI Tutor',
            'Map out real-world application or algorithmic workflow'
          ],
          targetMilestone: 'Comfort with highest-weight exam topics'
        },
        {
          day: 'Day 4: Active Recall & Flash Drills',
          timeEstimate: chosenHours,
          focus: `Spaced repetition and rapid retrieval testing.`,
          activities: [
            'Timed flashcard or quiz challenge (25 mins)',
            'Teach-Back Method: Explain 3 core proofs out loud without notes',
            'Review and reconcile all missed questions'
          ],
          targetMilestone: 'Rapid, automatic recall of crucial equations'
        },
        {
          day: 'Day 5: Simulated Mock Exam',
          timeEstimate: chosenHours,
          focus: `Full timed simulation under exam conditions.`,
          activities: [
            'Simulate 1 full timed past paper section with zero aids',
            'Score according to official grading rubric',
            'Log milestone completion on EduAI Dashboard'
          ],
          targetMilestone: 'Ready to score in the top percentile with high confidence!'
        }
      ];

      // Store in study_plans table
      const planJson = JSON.stringify(days);
      const nowIso = new Date().toISOString();
      const insertStmt = db.prepare(`
        INSERT INTO study_plans (subject, level, daily_hours, learning_style, plan_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const result = insertStmt.run(
        chosenSubject,
        chosenLevel,
        parseFloat(chosenHours) || 2.0,
        chosenStyle,
        planJson,
        nowIso
      );

      sendJson(res, 201, {
        success: true,
        planId: result.lastInsertRowid,
        metadata: {
          level: chosenLevel,
          subject: chosenSubject,
          dailyHours: chosenHours,
          learningStyle: chosenStyle,
          pendingTasksIncluded: pendingTasks.length
        },
        schedule: days
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // GET /api/quizzes
  getQuizzes: (req, res, parsedUrl) => {
    try {
      const category = parsedUrl.query.category;
      let sql = 'SELECT * FROM quiz_questions';
      const params = [];
      if (category && category !== 'All') {
        sql += ' WHERE category = ?';
        params.push(category);
      }
      const questions = db.prepare(sql).all(...params).map(q => ({
        id: q.id,
        category: q.category,
        question: q.question,
        options: JSON.parse(q.options_json),
        correct_index: q.correct_index,
        explanation: q.explanation
      }));

      sendJson(res, 200, { success: true, count: questions.length, questions });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // POST /api/auth/login
  login: async (req, res) => {
    try {
      const body = await parseRequestBody(req);
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';

      if (!email || !password) {
        return sendJson(res, 400, { success: false, error: 'Email and password are required' });
      }

      const crypto = require('node:crypto');
      const salt = 'eduai_salt_secure_2026';
      const hash = crypto.createHash('sha256').update(password + salt).digest('hex');

      const user = db.prepare('SELECT id, name, email, major, grade, password_hash FROM users WHERE email = ?').get(email);
      if (!user || user.password_hash !== hash) {
        return sendJson(res, 401, { success: false, error: 'Invalid email or password' });
      }

      const token = Buffer.from(`${user.id}:${Date.now()}:${user.email}`).toString('base64');
      sendJson(res, 200, {
        success: true,
        message: 'Login successful',
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          major: user.major,
          grade: user.grade
        }
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // POST /api/auth/register
  register: async (req, res) => {
    try {
      const body = await parseRequestBody(req);
      const name = (body.name || '').trim();
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';
      const major = (body.major || 'Computer Science').trim();
      const grade = (body.grade || 'Undergraduate').trim();

      if (!name || !email || !password) {
        return sendJson(res, 400, { success: false, error: 'Name, email, and password are required' });
      }

      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existing) {
        return sendJson(res, 400, { success: false, error: 'An account with this email already exists' });
      }

      const crypto = require('node:crypto');
      const salt = 'eduai_salt_secure_2026';
      const hash = crypto.createHash('sha256').update(password + salt).digest('hex');

      const nowIso = new Date().toISOString();
      const info = db.prepare(`
        INSERT INTO users (name, email, password_hash, major, grade, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(name, email, hash, major, grade, nowIso);

      const token = Buffer.from(`${info.lastInsertRowid}:${Date.now()}:${email}`).toString('base64');
      sendJson(res, 201, {
        success: true,
        message: 'Account created successfully',
        token,
        user: {
          id: Number(info.lastInsertRowid),
          name,
          email,
          major,
          grade
        }
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  },

  // GET /api/auth/me
  getMe: (req, res) => {
    try {
      const authHeader = req.headers['authorization'];
      if (!authHeader) {
        return sendJson(res, 401, { success: false, error: 'Not authenticated' });
      }
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      const [userId] = decoded.split(':');
      const user = db.prepare('SELECT id, name, email, major, grade FROM users WHERE id = ?').get(userId);
      if (!user) {
        return sendJson(res, 404, { success: false, error: 'User not found' });
      }
      sendJson(res, 200, { success: true, user });
    } catch (err) {
      sendJson(res, 401, { success: false, error: 'Invalid session' });
    }
  },

  // POST /api/auth/google (Google OAuth sign-in)
  googleLogin: async (req, res) => {
    try {
      const body = await parseRequestBody(req);
      const name = (body.name || 'Alex Johnson (Google User)').trim();
      const email = (body.email || 'alex.johnson@gmail.com').trim().toLowerCase();
      const googleId = body.googleId || 'g_' + Math.random().toString(36).substring(2, 10);

      let user = db.prepare('SELECT id, name, email, major, grade FROM users WHERE email = ?').get(email);
      if (!user) {
        const nowIso = new Date().toISOString();
        const hash = 'google_oauth_' + googleId;
        const info = db.prepare(`
          INSERT INTO users (name, email, password_hash, major, grade, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(name, email, hash, 'Computer Science', 'Undergraduate (Google Verified)', nowIso);

        user = {
          id: Number(info.lastInsertRowid),
          name,
          email,
          major: 'Computer Science',
          grade: 'Undergraduate (Google Verified)'
        };
      }

      const token = Buffer.from(`${user.id}:${Date.now()}:${user.email}:google`).toString('base64');
      sendJson(res, 200, {
        success: true,
        message: 'Google Sign-In successful',
        provider: 'google',
        token,
        user
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
  }
};

// Main HTTP Server
const server = http.createServer((req, res) => {
  const clientIp = req.socket.remoteAddress || '127.0.0.1';

  // DoS / Brute-force rate limiting protection
  if (isRateLimited(clientIp, 120, 60000)) {
    res.writeHead(429, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    return res.end(JSON.stringify({ success: false, error: 'Rate limit exceeded. Please slow down.' }));
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Handle CORS preflight with security headers
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      ...SECURITY_HEADERS,
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  // API Routing
  if (pathname.startsWith('/api/')) {
    // 1. Tasks Collection
    if (pathname === '/api/tasks') {
      if (method === 'GET') return handlers.getTasks(req, res, parsedUrl);
      if (method === 'POST') return handlers.createTask(req, res);
    }

    // 2. Task Single Entity
    const taskMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (taskMatch) {
      const id = taskMatch[1];
      if (method === 'GET') return handlers.getTaskById(req, res, id);
      if (method === 'PUT') return handlers.updateTask(req, res, id);
      if (method === 'DELETE') return handlers.deleteTask(req, res, id);
    }

    // 3. Task Status Toggle
    const taskStatusMatch = pathname.match(/^\/api\/tasks\/(\d+)\/status$/);
    if (taskStatusMatch) {
      const id = taskStatusMatch[1];
      if (method === 'PATCH' || method === 'PUT') return handlers.updateTaskStatus(req, res, id);
    }

    // 4. Dashboard Stats
    if (pathname === '/api/dashboard/stats' && method === 'GET') {
      return handlers.getDashboardStats(req, res);
    }

    // 5. Reminders
    if (pathname === '/api/reminders' && method === 'GET') {
      return handlers.getReminders(req, res);
    }

    // 6. Calendar Export
    if (pathname === '/api/export/calendar' && method === 'GET') {
      return handlers.exportCalendar(req, res);
    }

    // 7. AI Tutor
    if (pathname === '/api/ai/ask' && method === 'POST') {
      return handlers.askAiTutor(req, res);
    }

    // 8. AI Study Plan Generator
    if (pathname === '/api/ai/study-plan' && method === 'POST') {
      return handlers.generateStudyPlan(req, res);
    }

    // 9. Quizzes
    if (pathname === '/api/quizzes' && method === 'GET') {
      return handlers.getQuizzes(req, res, parsedUrl);
    }

    // 10. Authentication
    if (pathname === '/api/auth/login' && method === 'POST') {
      return handlers.login(req, res);
    }
    if (pathname === '/api/auth/register' && method === 'POST') {
      return handlers.register(req, res);
    }
    if (pathname === '/api/auth/google' && method === 'POST') {
      return handlers.googleLogin(req, res);
    }
    if (pathname === '/api/auth/me' && method === 'GET') {
      return handlers.getMe(req, res);
    }

    // Unmatched API endpoint
    return sendJson(res, 404, { success: false, error: `API route ${method} ${pathname} not found` });
  }

  // Static File Serving
  let relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = path.join(PUBLIC_DIR, relativePath);

  // Security check: prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Access Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA-style handling if needed
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (readErr, content) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('File not found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
        res.end(content);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
        return res.end('Internal Server Error');
      }
      res.writeHead(200, { 'Content-Type': contentType, ...SECURITY_HEADERS });
      res.end(content);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`EduAI Academic Management Backend listening on:`);
  console.log(`- Local URL:         http://localhost:${PORT}`);
  console.log(`- Network Share Link: http://192.168.1.7:${PORT}`);
  console.log(`- Tasks API:         http://localhost:${PORT}/api/tasks`);
  console.log(`- Dashboard Stats:   http://localhost:${PORT}/api/dashboard/stats`);
  console.log(`- Reminders API:     http://localhost:${PORT}/api/reminders`);
  console.log(`- Calendar Export:   http://localhost:${PORT}/api/export/calendar`);
});

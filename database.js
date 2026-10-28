const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dbPath = path.join(__dirname, 'student_academic.db');
const db = new DatabaseSync(dbPath);

// Enable WAL mode for better concurrency and performance
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('Assignment', 'Examination', 'Project', 'Extracurricular', 'General')),
    subject TEXT NOT NULL,
    priority TEXT NOT NULL CHECK(priority IN ('Urgent', 'High', 'Medium', 'Low')),
    due_date TEXT NOT NULL,
    estimated_hours REAL DEFAULT 1.0,
    status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'completed')),
    description TEXT DEFAULT '',
    reminder_lead INTEGER DEFAULT 24,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS study_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    level TEXT NOT NULL,
    daily_hours REAL NOT NULL,
    learning_style TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS quiz_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    question TEXT NOT NULL,
    options_json TEXT NOT NULL,
    correct_index INTEGER NOT NULL,
    explanation TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    major TEXT DEFAULT 'Computer Science',
    grade TEXT DEFAULT 'Undergraduate',
    created_at TEXT NOT NULL
  );
`);

// Helper to seed realistic academic tasks if database is brand new
function seedInitialData() {
  const now = new Date();

  // Ensure default demo student exists
  const crypto = require('node:crypto');
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const salt = 'eduai_salt_secure_2026';
    const hash = crypto.createHash('sha256').update('student123' + salt).digest('hex');
    db.prepare(`
      INSERT INTO users (name, email, password_hash, major, grade, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('Alex Johnson', 'alex@student.edu', hash, 'Computer Science', 'Undergraduate (3rd Year)', now.toISOString());
    console.log('Demo student account (alex@student.edu) created.');
  }

  const countRow = db.prepare('SELECT COUNT(*) as count FROM tasks').get();
  if (countRow.count > 0) {
    return; // Tasks already seeded
  }
  
  // Format dates relative to current execution time
  const formatOffset = (hoursOffset) => {
    const d = new Date(now.getTime() + hoursOffset * 60 * 60 * 1000);
    return d.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:mm"
  };

  const sampleTasks = [
    {
      title: 'CS301 Data Structures: Red-Black Tree Implementation',
      category: 'Project',
      subject: 'Computer Science',
      priority: 'Urgent',
      due_date: formatOffset(14), // Due in 14 hours (Today!)
      estimated_hours: 4.5,
      status: 'in_progress',
      description: 'Implement rotation and balancing operations in Java or C++. Verify all invariant tests pass.',
      reminder_lead: 12
    },
    {
      title: 'Calculus II: Multivariable Integration Problem Set 5',
      category: 'Assignment',
      subject: 'Mathematics',
      priority: 'High',
      due_date: formatOffset(32), // Due tomorrow
      estimated_hours: 3.0,
      status: 'todo',
      description: 'Solve problems 14 through 28 on double integrals and polar coordinates. Show step-by-step proofs.',
      reminder_lead: 24
    },
    {
      title: 'PHYS202 Physics Midterm Examination',
      category: 'Examination',
      subject: 'Physics',
      priority: 'Urgent',
      due_date: formatOffset(65), // In ~2.5 days
      estimated_hours: 8.0,
      status: 'todo',
      description: 'Covers Maxwell equations, magnetic induction, and electromagnetic wave propagation. Bring scientific calculator.',
      reminder_lead: 48
    },
    {
      title: 'Robotics Club Annual Autonomous Rover Showcase',
      category: 'Extracurricular',
      subject: 'Extracurricular / Club',
      priority: 'Medium',
      due_date: formatOffset(110), // In ~4.5 days
      estimated_hours: 2.5,
      status: 'in_progress',
      description: 'Prepare demonstration booth, tune PID motor controller calibration, and print technical poster.',
      reminder_lead: 24
    },
    {
      title: 'Organic Chemistry Lab: Spectroscopic Analysis Report',
      category: 'Assignment',
      subject: 'Chemistry',
      priority: 'Medium',
      due_date: formatOffset(150), // In ~6 days
      estimated_hours: 3.5,
      status: 'todo',
      description: 'Analyze NMR and IR spectrograms for unknown compound sample #4. Document peak assignments and purity.',
      reminder_lead: 24
    },
    {
      title: 'Inter-Collegiate Hackathon: Pitch Deck & Architecture Diagram',
      category: 'Extracurricular',
      subject: 'Extracurricular / Club',
      priority: 'Low',
      due_date: formatOffset(190), // In ~8 days
      estimated_hours: 2.0,
      status: 'todo',
      description: 'Draft 5-minute slide deck and system topology diagram for AI study group platform.',
      reminder_lead: 24
    },
    {
      title: 'English Composition: Critical Essay on Digital Privacy',
      category: 'Assignment',
      subject: 'English Literature',
      priority: 'Low',
      due_date: formatOffset(-18), // Completed yesterday
      estimated_hours: 4.0,
      status: 'completed',
      description: '1500-word argumentative essay with at least 5 peer-reviewed scholarly citations.',
      reminder_lead: 24
    }
  ];

  const insertTask = db.prepare(`
    INSERT INTO tasks (
      title, category, subject, priority, due_date, estimated_hours, status, description, reminder_lead, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const createdTime = now.toISOString();

  for (const t of sampleTasks) {
    const completedTime = t.status === 'completed' ? now.toISOString() : null;
    insertTask.run(
      t.title,
      t.category,
      t.subject,
      t.priority,
      t.due_date,
      t.estimated_hours,
      t.status,
      t.description,
      t.reminder_lead,
      createdTime,
      createdTime,
      completedTime
    );
  }

  // Seed sample quiz questions
  const sampleQuizzes = [
    {
      category: 'Computer Science',
      question: 'What is the average time complexity of searching an element in a balanced Binary Search Tree (BST)?',
      options: ['O(1)', 'O(n)', 'O(log n)', 'O(n²)'],
      correct_index: 2,
      explanation: 'In a balanced BST, each comparison cuts the search space approximately in half, yielding O(log n) time complexity.'
    },
    {
      category: 'Physics',
      question: 'If a vehicle accelerates uniformly from rest to 20 m/s in 5 seconds, what is its acceleration?',
      options: ['2 m/s²', '4 m/s²', '10 m/s²', '100 m/s²'],
      correct_index: 1,
      explanation: 'Acceleration a = (v - u) / t = (20 - 0) / 5 = 4 m/s².'
    },
    {
      category: 'Biology',
      question: 'Which cellular organelle is universally referred to as the powerhouse of eukaryotic cells?',
      options: ['Ribosome', 'Nucleus', 'Mitochondria', 'Endoplasmic Reticulum'],
      correct_index: 2,
      explanation: 'Mitochondria generate most of the chemical energy required by the cell through ATP production via oxidative phosphorylation.'
    },
    {
      category: 'Mathematics',
      question: 'What is the derivative of f(x) = ln(x) with respect to x?',
      options: ['1 / x', 'e^x', 'x', '1 / (2x)'],
      correct_index: 0,
      explanation: 'The standard derivative of the natural logarithm ln(x) is 1/x for all x > 0.'
    },
    {
      category: 'Chemistry',
      question: 'What is the pH value of a completely neutral aqueous solution at 25°C?',
      options: ['0', '7', '14', '1'],
      correct_index: 1,
      explanation: 'At 25°C, pure neutral water has equal hydrogen and hydroxide ion concentrations of 10^-7 M, corresponding to pH 7.'
    }
  ];

  const insertQuiz = db.prepare(`
    INSERT INTO quiz_questions (category, question, options_json, correct_index, explanation)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const q of sampleQuizzes) {
    insertQuiz.run(q.category, q.question, JSON.stringify(q.options), q.correct_index, q.explanation);
  }

  console.log('Database seeded successfully with initial academic tasks, quizzes, and demo student.');
}

seedInitialData();

module.exports = {
  db
};

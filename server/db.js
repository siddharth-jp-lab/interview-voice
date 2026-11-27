import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS, isLeaf, skillById } from "./skills.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = resolve(process.env.DATABASE_PATH || resolve(ROOT, "data/interview.db"));
const LEGACY = resolve(ROOT, "data/sessions.json");

let db;

export function openDb() {
  if (db) return db;
  mkdirSync(dirname(FILE), { recursive: true });
  db = new DatabaseSync(FILE);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      track TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      hint TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_skill (
      email TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      solid_streak INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      mastered_at TEXT,
      PRIMARY KEY (email, skill_id)
    );
    CREATE TABLE IF NOT EXISTS user_focus (
      email TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      PRIMARY KEY (email, skill_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      track TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      transcript TEXT NOT NULL,
      debrief TEXT,
      skill_ids TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_grades (
      session_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      rating TEXT NOT NULL,
      PRIMARY KEY (session_id, skill_id)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      exp INTEGER NOT NULL
    );
  `);
  const columns = db.prepare("PRAGMA table_info(skills)").all();
  if (!columns.some((column) => column.name === "owner_email")) {
    db.exec("ALTER TABLE skills ADD COLUMN owner_email TEXT");
  }
  const progressColumns = db.prepare("PRAGMA table_info(user_skill)").all();
  if (!progressColumns.some((column) => column.name === "gap")) {
    db.exec("ALTER TABLE user_skill ADD COLUMN gap TEXT");
  }
  const skillColumns = db.prepare("PRAGMA table_info(skills)").all();
  if (!skillColumns.some((column) => column.name === "detail")) {
    db.exec("ALTER TABLE skills ADD COLUMN detail TEXT NOT NULL DEFAULT ''");
  }
  if (!skillColumns.some((column) => column.name === "reading")) {
    db.exec("ALTER TABLE skills ADD COLUMN reading TEXT NOT NULL DEFAULT '{\"sources\":[],\"references\":[]}'");
  }
  const upsert = db.prepare(`
    INSERT INTO skills (id, track, parent_id, title, hint, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      track = excluded.track,
      parent_id = excluded.parent_id,
      title = excluded.title,
      hint = excluded.hint,
      sort_order = excluded.sort_order
  `);
  for (const skill of SKILLS) {
    upsert.run(skill.id, skill.track, skill.parentId, skill.title, skill.hint, skill.sort);
  }
  migrateLegacy();
  return db;
}

export function nextProgress(current, rating) {
  const attempts = (current?.attempts || 0) + 1;
  if (rating === "solid") {
    const streak = (current?.solidStreak || 0) + 1;
    const masteredAt = streak >= 2 ? current?.masteredAt || new Date().toISOString() : null;
    return { solidStreak: streak, attempts, masteredAt };
  }
  return { solidStreak: 0, attempts, masteredAt: null };
}

export function skillTree(email) {
  const database = openDb();
  const progress = new Map(
    database.prepare("SELECT skill_id, solid_streak, attempts, mastered_at, gap FROM user_skill WHERE email = ?").all(email).map((row) => [row.skill_id, row]),
  );
  const focus = new Set(database.prepare("SELECT skill_id FROM user_focus WHERE email = ?").all(email).map((row) => row.skill_id));
  const notes = skillNotes(database);
  const trees = ["backend", "ai"].map((track) => ({
    track,
    title: track === "backend" ? "Backend systems" : "AI engineering",
    groups: SKILLS.filter((skill) => skill.track === track && !skill.parentId).map((group) => groupState(withNotes(group, notes), SKILLS.map((skill) => withNotes(skill, notes)), progress, focus)),
  }));
  const custom = database.prepare("SELECT id, parent_id, title, hint, sort_order, detail, reading FROM skills WHERE owner_email = ? ORDER BY sort_order, id").all(email).map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    hint: row.hint,
    sort: row.sort_order,
    detail: row.detail || "",
    reading: parseReading(row.reading),
    custom: true,
  }));
  trees.push({
    track: "yours",
    title: "Yours",
    custom: true,
    groups: custom.filter((skill) => !skill.parentId).map((group) => groupState(group, custom, progress, focus)),
  });
  return trees;
}

export function resolveSkill(id) {
  const row = openDb().prepare("SELECT id, track, parent_id, title, hint, detail, reading FROM skills WHERE id = ?").get(id);
  const builtin = skillById(id);
  if (builtin) {
    return {
      ...builtin,
      detail: row?.detail || "",
      reading: parseReading(row?.reading),
    };
  }
  if (!row) return null;
  return {
    id: row.id,
    track: row.track,
    parentId: row.parent_id,
    title: row.title,
    hint: row.hint,
    detail: row.detail || "",
    reading: parseReading(row.reading),
  };
}

export function saveSkillBrief(id, brief) {
  const detail = String(brief?.detail || "").trim().slice(0, 4500);
  const reading = brief?.reading || { sources: [], references: [] };
  if (detail.length < 200 || !Array.isArray(reading.sources) || reading.sources.length === 0) return false;
  const result = openDb().prepare("UPDATE skills SET detail = ?, reading = ? WHERE id = ?").run(detail, JSON.stringify(reading), id);
  return result.changes > 0;
}

export function skillsToResearch() {
  return openDb().prepare(`
    SELECT id, title, parent_id FROM skills
    WHERE detail IS NULL OR length(trim(detail)) < 200
    ORDER BY sort_order, id
  `).all().map((row) => {
    const parent = row.parent_id ? openDb().prepare("SELECT title FROM skills WHERE id = ?").get(row.parent_id) : null;
    return { id: row.id, title: row.title, parentTitle: parent?.title || "" };
  });
}

export function customGroup(email, id) {
  const row = openDb().prepare("SELECT title FROM skills WHERE id = ? AND owner_email = ? AND parent_id IS NULL").get(id, email);
  return row ? { id, title: row.title } : null;
}

export function saveCustomBranch(email, branch) {
  const database = openDb();
  const leaves = Array.isArray(branch?.leaves) ? branch.leaves : [];
  if (branch?.groupId) {
    const group = database.prepare("SELECT id FROM skills WHERE id = ? AND owner_email = ? AND parent_id IS NULL").get(branch.groupId, email);
    if (!group || leaves.length < 3) return null;
    database.exec("BEGIN");
    try {
      insertLeaves(database, email, group.id, leaves);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return skillTree(email);
  }
  const title = String(branch?.title || "").trim().slice(0, 80);
  if (title.length < 2 || leaves.length < 4) return null;
  const groupId = customId();
  const sort = nextSort(database, email);
  database.exec("BEGIN");
  try {
    database.prepare(`
      INSERT INTO skills (id, track, parent_id, title, hint, sort_order, owner_email, detail, reading)
      VALUES (?, 'yours', NULL, ?, '', ?, ?, ?, ?)
    `).run(groupId, title, sort, email, String(branch.detail || "").slice(0, 4500), JSON.stringify(branch.reading || { sources: [], references: [] }));
    insertLeaves(database, email, groupId, leaves);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return skillTree(email);
}

export function renameOwnedSkill(email, id, title) {
  const next = String(title || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (next.length < 2) return null;
  const result = openDb().prepare("UPDATE skills SET title = ? WHERE id = ? AND owner_email = ?").run(next, id, email);
  if (!result.changes) return null;
  return skillTree(email);
}

export function deleteOwnedSkill(email, id) {
  const database = openDb();
  const row = database.prepare("SELECT id, parent_id FROM skills WHERE id = ? AND owner_email = ?").get(id, email);
  if (!row) return null;
  const ids = row.parent_id
    ? [row.id]
    : [row.id, ...database.prepare("SELECT id FROM skills WHERE parent_id = ? AND owner_email = ?").all(row.id, email).map((item) => item.id)];
  const marks = ids.map(() => "?").join(", ");
  database.exec("BEGIN");
  try {
    database.prepare(`DELETE FROM user_focus WHERE email = ? AND skill_id IN (${marks})`).run(email, ...ids);
    database.prepare(`DELETE FROM user_skill WHERE email = ? AND skill_id IN (${marks})`).run(email, ...ids);
    database.prepare(`DELETE FROM skills WHERE owner_email = ? AND id IN (${marks})`).run(email, ...ids);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return skillTree(email);
}

function ownedLeaf(email, id) {
  if (isLeaf(id)) return true;
  const row = openDb().prepare("SELECT parent_id, owner_email FROM skills WHERE id = ?").get(id);
  return Boolean(row?.parent_id && row.owner_email === email);
}

function groupState(group, catalog, progress, focus) {
  const children = catalog.filter((skill) => skill.parentId === group.id).map((skill) => ({
    ...leafState(skill, progress.get(skill.id), focus.has(skill.id)),
    custom: Boolean(skill.custom),
    detail: skill.detail || "",
    reading: skill.reading || { sources: [], references: [] },
  }));
  const masteredCount = children.filter((child) => child.mastered).length;
  const started = children.some((child) => child.attempts > 0);
  return {
    id: group.id,
    title: group.title,
    custom: Boolean(group.custom),
    detail: group.detail || "",
    reading: group.reading || { sources: [], references: [] },
    mastered: children.length > 0 && masteredCount === children.length,
    state: masteredCount === children.length && children.length > 0 ? "mastered" : started ? "progress" : "untouched",
    children,
  };
}

function insertLeaves(database, email, groupId, leaves) {
  const insert = database.prepare(`
    INSERT INTO skills (id, track, parent_id, title, hint, sort_order, owner_email, detail, reading)
    VALUES (?, 'yours', ?, ?, ?, ?, ?, ?, ?)
  `);
  const base = database.prepare("SELECT COALESCE(MAX(sort_order), -1) AS sort FROM skills WHERE parent_id = ?").get(groupId);
  leaves.forEach((leaf, index) => {
    insert.run(
      customId(),
      groupId,
      leaf.title,
      leaf.hint,
      (base?.sort ?? -1) + 1 + index,
      email,
      leaf.detail || "",
      JSON.stringify(leaf.reading || { sources: [], references: [] }),
    );
  });
}

function skillNotes(database) {
  return new Map(database.prepare("SELECT id, detail, reading FROM skills").all().map((row) => [row.id, { detail: row.detail || "", reading: parseReading(row.reading) }]));
}

function withNotes(skill, notes) {
  const note = notes.get(skill.id) || { detail: "", reading: { sources: [], references: [] } };
  return { ...skill, detail: note.detail, reading: note.reading };
}

export function parseReading(value) {
  const parsed = typeof value === "string" ? parseJson(value, null) : value;
  const sources = Array.isArray(parsed?.sources) ? parsed.sources : [];
  const references = Array.isArray(parsed?.references) ? parsed.references : [];
  return {
    sources: sources.filter((item) => item?.title && item?.url),
    references: references.filter((item) => item?.title && item?.url),
  };
}

function nextSort(database, email) {
  const row = database.prepare("SELECT COALESCE(MAX(sort_order), 0) AS sort FROM skills WHERE owner_email = ? AND parent_id IS NULL").get(email);
  return (row?.sort || 0) + 1;
}

function customId() {
  return `c${randomBytes(8).toString("hex")}`;
}

export function saveFocus(email, ids) {
  const database = openDb();
  const leaves = [...new Set(ids.filter((id) => ownedLeaf(email, id)))];
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM user_focus WHERE email = ?").run(email);
    const insert = database.prepare("INSERT INTO user_focus (email, skill_id) VALUES (?, ?)");
    for (const id of leaves) insert.run(email, id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return leaves;
}

export function createInterview(email, skillIds) {
  const ids = [...new Set((skillIds || []).filter((id) => ownedLeaf(email, id)))];
  if (ids.length === 0) return null;
  const tracks = new Set(ids.map((id) => resolveSkill(id)?.track).filter(Boolean));
  const track = tracks.size === 1 ? [...tracks][0] : "mixed";
  const row = {
    id: randomBytes(16).toString("hex"),
    email,
    track,
    started_at: new Date().toISOString(),
    ended_at: null,
    transcript: "[]",
    debrief: null,
    skill_ids: JSON.stringify(ids),
  };
  openDb().prepare(`
    INSERT INTO sessions (id, email, track, started_at, ended_at, transcript, debrief, skill_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.email, row.track, row.started_at, row.ended_at, row.transcript, row.debrief, row.skill_ids);
  return present(row, []);
}

export function listInterviews(email) {
  return openDb().prepare("SELECT * FROM sessions WHERE email = ? ORDER BY started_at DESC").all(email).map((row) => summarize(row));
}

export function getInterview(email, id) {
  const row = openDb().prepare("SELECT * FROM sessions WHERE email = ? AND id = ?").get(email, id);
  if (!row) return null;
  const grades = openDb().prepare(`
    SELECT skill_grades.skill_id, skill_grades.rating, skills.title
    FROM skill_grades
    JOIN skills ON skills.id = skill_grades.skill_id
    WHERE skill_grades.session_id = ?
  `).all(id);
  return present(row, grades);
}

export function updateInterview(email, id, patch) {
  const database = openDb();
  const row = database.prepare("SELECT * FROM sessions WHERE email = ? AND id = ?").get(email, id);
  if (!row) return null;
  const transcript = Array.isArray(patch.transcript) ? JSON.stringify(cleanTranscript(patch.transcript)) : row.transcript;
  const endedAt = patch.ended ? new Date().toISOString() : row.ended_at;
  const debrief = patch.debrief
    ? JSON.stringify({
        strong: String(patch.debrief.strong || "").slice(0, 4000),
        missing: String(patch.debrief.missing || "").slice(0, 4000),
        outline: String(patch.debrief.outline || "").slice(0, 4000),
      })
    : row.debrief;
  database.prepare("UPDATE sessions SET transcript = ?, ended_at = ?, debrief = ? WHERE id = ?").run(transcript, endedAt, debrief, id);
  return getInterview(email, id);
}

export function deleteInterview(email, id) {
  const database = openDb();
  database.exec("BEGIN");
  try {
    const existing = database.prepare("SELECT id FROM sessions WHERE email = ? AND id = ?").get(email, id);
    if (!existing) {
      database.exec("ROLLBACK");
      return false;
    }
    database.prepare("DELETE FROM skill_grades WHERE session_id = ?").run(id);
    database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    database.exec("COMMIT");
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function applyGrades(email, sessionId, grades, gaps = []) {
  const interview = getInterview(email, sessionId);
  if (!interview) return null;
  const allowed = new Set(interview.skillIds);
  const notes = new Map(
    (Array.isArray(gaps) ? gaps : [])
      .filter((item) => item && allowed.has(item.id) && typeof item.note === "string" && item.note.trim())
      .map((item) => [item.id, item.note.trim().slice(0, 280)]),
  );
  const database = openDb();
  const applied = [];
  database.exec("BEGIN");
  try {
    for (const grade of grades || []) {
      const rating = grade?.rating;
      if (!allowed.has(grade?.id) || !["solid", "partial", "miss"].includes(rating)) continue;
      const current = database.prepare("SELECT solid_streak, attempts, mastered_at FROM user_skill WHERE email = ? AND skill_id = ?").get(email, grade.id);
      const next = nextProgress(current && {
        solidStreak: current.solid_streak,
        attempts: current.attempts,
        masteredAt: current.mastered_at,
      }, rating);
      const gap = rating === "solid" ? null : notes.get(grade.id) || "The answer still has a gap.";
      database.prepare(`
        INSERT INTO user_skill (email, skill_id, solid_streak, attempts, mastered_at, gap)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(email, skill_id) DO UPDATE SET
          solid_streak = excluded.solid_streak,
          attempts = excluded.attempts,
          mastered_at = excluded.mastered_at,
          gap = excluded.gap
      `).run(email, grade.id, next.solidStreak, next.attempts, next.masteredAt, gap);
      database.prepare(`
        INSERT INTO skill_grades (session_id, skill_id, rating)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id, skill_id) DO UPDATE SET rating = excluded.rating
      `).run(sessionId, grade.id, rating);
      applied.push({
        id: grade.id,
        title: resolveSkill(grade.id)?.title || grade.id,
        rating,
        streak: next.solidStreak,
        mastered: Boolean(next.masteredAt),
      });
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return applied;
}

export function skillsForSession(email, sessionId) {
  const interview = getInterview(email, sessionId);
  if (!interview) return null;
  const progress = new Map(
    openDb().prepare("SELECT skill_id, mastered_at FROM user_skill WHERE email = ?").all(email).map((row) => [row.skill_id, row]),
  );
  return interview.skillIds
    .map((id) => {
      const skill = resolveSkill(id);
      if (!skill) return null;
      return { ...skill, mastered: Boolean(progress.get(id)?.mastered_at) };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.mastered) - Number(b.mastered));
}

export function cleanTranscript(transcript) {
  return transcript
    .filter((line) => line && (line.role === "user" || line.role === "assistant") && typeof line.text === "string")
    .slice(0, 80)
    .map((line) => ({ role: line.role, text: line.text.trim().slice(0, 2000) }))
    .filter((line) => line.text);
}

function leafState(skill, row, checked) {
  const attempts = row?.attempts || 0;
  const streak = row?.solid_streak || 0;
  const mastered = Boolean(row?.mastered_at);
  return {
    id: skill.id,
    title: skill.title,
    streak,
    attempts,
    mastered,
    checked,
    state: mastered ? "mastered" : attempts > 0 ? "progress" : "untouched",
    gap: mastered ? "" : row?.gap || "",
  };
}

function summarize(row) {
  const transcript = parseJson(row.transcript, []);
  const skillIds = parseJson(row.skill_ids, []);
  const last = transcript.at(-1);
  const names = skillIds.map((id) => resolveSkill(id)?.title).filter(Boolean);
  return {
    id: row.id,
    track: row.track,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    preview: last ? last.text.slice(0, 90) : "No transcript yet",
    skills: names.slice(0, 4),
  };
}

function present(row, grades) {
  return {
    id: row.id,
    track: row.track,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    transcript: parseJson(row.transcript, []),
    debrief: parseJson(row.debrief, null),
    skillIds: parseJson(row.skill_ids, []),
    grades: (grades || []).map((grade) => ({
      id: grade.skill_id,
      title: grade.title,
      rating: grade.rating,
    })),
  };
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function migrateLegacy() {
  const done = db.prepare("SELECT value FROM meta WHERE key = ?").get("legacy_sessions");
  if (done) return;
  if (existsSync(LEGACY)) {
    try {
      const rows = JSON.parse(readFileSync(LEGACY, "utf8"));
      const insert = db.prepare(`
        INSERT OR IGNORE INTO sessions (id, email, track, started_at, ended_at, transcript, debrief, skill_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (!row?.id || !row?.email) continue;
          insert.run(
            row.id,
            row.email,
            row.track || "mixed",
            row.startedAt || new Date().toISOString(),
            row.endedAt || null,
            JSON.stringify(Array.isArray(row.transcript) ? row.transcript : []),
            row.debrief ? JSON.stringify(row.debrief) : null,
            "[]",
          );
        }
      }
    } catch {
      // Leave the JSON file untouched and still mark the attempt so a bad file cannot block startup.
    }
  }
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("legacy_sessions", "1");
}

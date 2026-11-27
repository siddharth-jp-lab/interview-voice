import { setDefaultResultOrder } from "node:dns";
import { createServer } from "node:http";

setDefaultResultOrder("ipv4first");
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instructionsForSkills } from "./prompts.js";
import {
  applyGrades,
  cleanTranscript,
  createInterview,
  customGroup,
  deleteInterview,
  deleteOwnedSkill,
  getInterview,
  listInterviews,
  openDb,
  renameOwnedSkill,
  resolveSkill,
  saveCustomBranch,
  saveFocus,
  skillTree,
  skillsForSession,
  updateInterview,
} from "./db.js";
import { researchTopic } from "./research.js";
import {
  allow,
  authConfigured,
  clearCookie,
  clientIp,
  destroySession,
  loginOk,
  readSession,
  sessionCookie,
  signSession,
} from "./auth.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "web/dist");
const PORT = Number(process.env.PORT || 8787);
const MODEL = "gpt-realtime-2.1";

loadEnv(resolve(ROOT, ".env"));
openDb();

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, null);
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/me") {
      const session = readSession(req);
      if (!session) {
        send(res, 401, { error: "Sign in required" });
        return;
      }
      send(res, 200, { email: session.email });
      return;
    }

    if (req.method === "POST" && url.pathname === "/login") {
      if (!allow(`login:${clientIp(req)}`, 8, 15 * 60 * 1000)) {
        send(res, 429, { error: "Too many sign-in attempts. Wait and try again." });
        return;
      }
      if (!authConfigured()) {
        send(res, 503, { error: "Sign-in is not configured" });
        return;
      }
      const body = await readJson(req, 2048);
      if (!loginOk(body.email, body.passphrase)) {
        send(res, 401, { error: "Email or passphrase is wrong" });
        return;
      }
      res.setHeader("Set-Cookie", sessionCookie(signSession(body.email)));
      send(res, 200, { email: String(body.email).trim().toLowerCase() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/logout") {
      destroySession(req);
      res.setHeader("Set-Cookie", clearCookie());
      send(res, 204, null);
      return;
    }

    if (url.pathname === "/skills" || url.pathname.startsWith("/skills/")) {
      await handleSkills(req, res, url);
      return;
    }

    if (url.pathname === "/sessions" || url.pathname.startsWith("/sessions/")) {
      await handleInterviews(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname === "/token") {
      const user = readSession(req);
      if (!user) {
        send(res, 401, { error: "Sign in required" });
        return;
      }
      if (!allow(`token:${clientIp(req)}`, 12, 60 * 60 * 1000)) {
        send(res, 429, { error: "Too many interview starts. Wait and try again." });
        return;
      }
      const sessionId = url.searchParams.get("session") || "";
      const interview = getInterview(user.email, sessionId);
      const skills = skillsForSession(user.email, sessionId);
      if (!skills || skills.length === 0) {
        send(res, 404, { error: "Session not found" });
        return;
      }
      if (!process.env.OPENAI_API_KEY) {
        send(res, 503, { error: "Set OPENAI_API_KEY in .env" });
        return;
      }
      const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: MODEL,
            instructions: instructionsForSkills(skills, { resume: Boolean(interview?.transcript?.length) }),
            audio: {
              input: {
                transcription: { model: "gpt-4o-mini-transcribe" },
                turn_detection: { type: "semantic_vad" },
              },
              output: { voice: "marin" },
            },
          },
        }),
      });
      const data = await upstream.json();
      if (!upstream.ok) {
        send(res, 502, { error: "Token request failed" });
        return;
      }
      send(res, 200, { value: data.value, expires_at: data.expires_at });
      return;
    }

    if (req.method === "POST" && url.pathname === "/debrief") {
      const user = readSession(req);
      if (!user) {
        send(res, 401, { error: "Sign in required" });
        return;
      }
      if (!allow(`debrief:${clientIp(req)}`, 8, 60 * 60 * 1000)) {
        send(res, 429, { error: "Too many debriefs. Wait and try again." });
        return;
      }
      if (!process.env.OPENAI_API_KEY) {
        send(res, 503, { error: "Set OPENAI_API_KEY in .env" });
        return;
      }
      const body = await readJson(req, 64 * 1024);
      const interview = typeof body.sessionId === "string" && body.sessionId ? getInterview(user.email, body.sessionId) : null;
      if (body.sessionId && !interview) {
        send(res, 404, { error: "Session not found" });
        return;
      }
      const transcript = cleanTranscript(Array.isArray(body.transcript) ? body.transcript : []);
      const text = transcript
        .filter((line) => line && typeof line.text === "string" && line.text.trim())
        .map((line) => `${line.role === "user" ? "Candidate" : "Interviewer"}: ${line.text.trim().slice(0, 2000)}`)
        .join("\n")
        .slice(0, 20000);
      if (!text) {
        send(res, 400, { error: "Transcript is empty" });
        return;
      }
      const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You write interview debriefs. Return JSON with keys strong (string), missing (string), outline (string), grades (array of {id, rating}), and gaps (array of {id, note}). rating is solid, partial, or miss. Include a grade only for a skill the transcript actually covers. solid means the transcript covered what that skill's brief calls a solid answer. partial means some of that brief was covered. miss means the brief's required ideas were missing or wrong. For every partial or miss, add one gaps note: a single sentence naming the specific piece from that brief that was missing. Base every point on the transcript. Do not invent facts the candidate did not say.",
            },
            {
              role: "user",
              content: `${text}\n\nSkills:\n${(interview?.skillIds || []).map((id) => {
                const skill = resolveSkill(id);
                const brief = String(skill?.detail || "").trim().slice(0, 1500);
                return `${id}: ${skill?.title || id}\n${brief}`;
              }).join("\n\n")}`,
            },
          ],
        }),
      });
      const data = await upstream.json();
      if (!upstream.ok) {
        send(res, 502, { error: "Debrief request failed" });
        return;
      }
      const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
      const gaps = (Array.isArray(parsed.gaps) ? parsed.gaps : [])
        .map((item) => ({ id: String(item?.id || ""), note: String(item?.note || "").trim().slice(0, 280) }))
        .filter((item) => item.id && item.note);
      const debrief = {
        strong: parsed.strong || "",
        missing: parsed.missing || "",
        outline: parsed.outline || "",
        gaps,
      };
      let grades = [];
      if (interview) {
        const saved = updateInterview(user.email, interview.id, { transcript, debrief, ended: true });
        if (!saved) {
          send(res, 404, { error: "Session not found" });
          return;
        }
        grades = applyGrades(user.email, interview.id, Array.isArray(parsed.grades) ? parsed.grades : [], gaps) || [];
      }
      send(res, 200, { ...debrief, grades });
      return;
    }

    if (req.method === "GET" && serveStatic(res, url.pathname)) return;

    send(res, 404, { error: "Not found" });
  } catch (error) {
    const status = error?.status || (error instanceof SyntaxError ? 400 : 500);
    send(res, status, { error: status === 413 ? "Request is too large" : status === 400 ? "Bad request" : "Server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Interview voice listening on http://0.0.0.0:${PORT}`);
});

async function handleSkills(req, res, url) {
  const user = readSession(req);
  if (!user) {
    send(res, 401, { error: "Sign in required" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/skills") {
    send(res, 200, { trees: skillTree(user.email) });
    return;
  }
  if (req.method === "PUT" && url.pathname === "/skills/focus") {
    const body = await readJson(req, 8192);
    const ids = saveFocus(user.email, Array.isArray(body.ids) ? body.ids : []);
    send(res, 200, { ids });
    return;
  }
  if (req.method === "POST" && url.pathname === "/skills/topics") {
    if (!allow(`topic:${user.email}`, 8, 60 * 60 * 1000)) {
      send(res, 429, { error: "Too many topics. Wait and try again." });
      return;
    }
    const body = await readJson(req, 4096);
    const topic = String(body.topic || "").trim();
    if (topic.length < 2) {
      send(res, 400, { error: "Name a topic" });
      return;
    }
    const groupId = typeof body.groupId === "string" ? body.groupId : "";
    const group = groupId ? customGroup(user.email, groupId) : null;
    if (groupId && !group) {
      send(res, 404, { error: "Group not found" });
      return;
    }
    const branch = await researchTopic(topic, group ? { groupTitle: group.title } : {});
    if (!branch) {
      send(res, 502, { error: "Could not turn that topic into skills" });
      return;
    }
    const trees = saveCustomBranch(user.email, groupId ? { groupId, leaves: branch.leaves } : branch);
    if (!trees) {
      send(res, 404, { error: "Group not found" });
      return;
    }
    send(res, 201, { trees });
    return;
  }
  const skillId = decodeURIComponent(url.pathname.slice("/skills/".length));
  if (!skillId || skillId.includes("/")) {
    send(res, 404, { error: "Not found" });
    return;
  }
  if (req.method === "PATCH") {
    const body = await readJson(req, 2048);
    const trees = renameOwnedSkill(user.email, skillId, body.title);
    send(res, trees ? 200 : 404, trees ? { trees } : { error: "Skill not found" });
    return;
  }
  if (req.method === "DELETE") {
    const trees = deleteOwnedSkill(user.email, skillId);
    send(res, trees ? 200 : 404, trees ? { trees } : { error: "Skill not found" });
    return;
  }
  send(res, 404, { error: "Not found" });
}

async function handleInterviews(req, res, url) {
  const user = readSession(req);
  if (!user) {
    send(res, 401, { error: "Sign in required" });
    return;
  }
  const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
  if (req.method === "GET" && url.pathname === "/sessions") {
    send(res, 200, { sessions: listInterviews(user.email) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/sessions") {
    const body = await readJson(req, 8192);
    const created = createInterview(user.email, Array.isArray(body.skillIds) ? body.skillIds : []);
    if (!created) {
      send(res, 400, { error: "Choose at least one skill" });
      return;
    }
    send(res, 201, created);
    return;
  }
  if (!/^[a-f0-9]{32}$/.test(id)) {
    send(res, 404, { error: "Session not found" });
    return;
  }
  if (req.method === "GET") {
    const row = getInterview(user.email, id);
    send(res, row ? 200 : 404, row || { error: "Session not found" });
    return;
  }
  if (req.method === "PUT") {
    const body = await readJson(req, 64 * 1024);
    const row = updateInterview(user.email, id, {
      transcript: body.transcript,
      ended: Boolean(body.ended),
    });
    send(res, row ? 200 : 404, row || { error: "Session not found" });
    return;
  }
  if (req.method === "DELETE") {
    const removed = deleteInterview(user.email, id);
    send(res, removed ? 204 : 404, removed ? null : { error: "Session not found" });
    return;
  }
  send(res, 404, { error: "Not found" });
}

function send(res, status, body) {
  const headers = {
    ...securityHeaders(),
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  };
  if (res.getHeader("Set-Cookie")) headers["Set-Cookie"] = res.getHeader("Set-Cookie");
  res.writeHead(status, headers);
  res.end(body == null ? "" : JSON.stringify(body));
}

function readJson(req, limit) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        succeed(raw ? JSON.parse(raw) : {});
      } catch (error) {
        fail(error);
      }
    });
    req.on("error", fail);
  });
}

function securityHeaders() {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "microphone=(self), camera=()",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.openai.com; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  };
  if (process.env.NODE_ENV === "production") {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webp": "image/webp",
};

function serveStatic(res, pathname) {
  if (!existsSync(DIST)) return false;
  let rel = decodeURIComponent(pathname.split("?")[0]);
  rel = rel === "/" ? "index.html" : rel.replace(/^\/+/, "");
  if (!rel || rel.split("/").includes("..")) return false;
  let file = resolve(DIST, rel);
  const distRoot = DIST.endsWith("/") ? DIST : `${DIST}/`;
  if (file !== DIST && !file.startsWith(distRoot)) return false;
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (extname(rel)) return false;
    file = resolve(DIST, "index.html");
    if (!existsSync(file)) return false;
  }
  res.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": STATIC_TYPES[extname(file)] || "application/octet-stream",
    "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=3600",
  });
  createReadStream(file).pipe(res);
  return true;
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

import { prepareCall, startSession } from "./session.js";

const loginEl = document.querySelector("#login");
const appEl = document.querySelector("#app");
const summaryEl = document.querySelector("#skill-summary");
const loginForm = document.querySelector("#login-form");
const emailInput = document.querySelector("#email");
const passphraseInput = document.querySelector("#passphrase");
const loginStatus = document.querySelector("#login-status");
const signOutButton = document.querySelector("#signout");
const treesEl = document.querySelector("#trees");
const skillsCard = document.querySelector("#skills-card");
const conversationEl = document.querySelector("#conversation");
const skillsTab = document.querySelector("#tab-skills");
const conversationTab = document.querySelector("#tab-conversation");
const practiceButton = document.querySelector("#practice");
const orb = document.querySelector("#orb");
const captionEl = document.querySelector("#caption");
const threadEl = document.querySelector("#thread");
const topicForm = document.querySelector("#topic-form");
const topicInput = document.querySelector("#topic");
const addTopicButton = document.querySelector("#add-topic");
const researchStatus = document.querySelector("#research-status");
const startButton = document.querySelector("#start");
const muteButton = document.querySelector("#mute");
const endButton = document.querySelector("#end");
const statusEl = document.querySelector("#status");
const whoEl = document.querySelector("#who");
const sessionListEl = document.querySelector("#session-list");
const transcriptEl = document.querySelector("#transcript");
const debriefEl = document.querySelector("#debrief");

const LIMIT_MS = 20 * 60 * 1000;
let session = null;
let interviewId = "";
let muted = false;
let lines = [];
let assistantBuffer = "";
let feedback = null;
let voice = "idle";
let limitTimer = 0;
let saveTimer = 0;
let focusTimer = 0;
let starting = false;

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginStatus.textContent = "Signing in";
  try {
    const response = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: emailInput.value,
        passphrase: passphraseInput.value,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Sign-in failed");
    passphraseInput.value = "";
    whoEl.textContent = payload.email || "";
    showApp(true);
    loadSkills();
    loadSessions();
  } catch (error) {
    loginStatus.textContent = error instanceof Error ? error.message : "Sign-in failed";
  }
});

signOutButton.addEventListener("click", async () => {
  if (session) session.stop();
  session = null;
  await fetch("/logout", { method: "POST" });
  showApp(false);
});

topicForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addTopic(topicInput.value, "");
});

skillsTab.addEventListener("click", () => showScreen("skills"));
conversationTab.addEventListener("click", () => showScreen("conversation"));
practiceButton.addEventListener("click", () => beginNew());
startButton.addEventListener("click", () => {
  if (interviewId) beginContinue();
  else beginNew();
});

muteButton.addEventListener("click", () => {
  if (!session) return;
  muted = !muted;
  session.mute(muted);
  muteButton.textContent = muted ? "Unmute" : "Mute";
  setVoice(muted ? "muted" : "listening");
});

endButton.addEventListener("click", () => {
  endInterview();
});

function handleEvent(event) {
  const type = event.type || "";
  if (!muted && type === "input_audio_buffer.speech_started") {
    setVoice("listening");
  }
  if (!muted && (type === "response.created" || type === "response.output_audio.delta" || type === "output_audio_buffer.started")) {
    setVoice("speaking");
  }
  if (!muted && (type === "response.done" || type === "response.output_audio.done" || type === "output_audio_buffer.stopped")) {
    setVoice("listening");
  }
  if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
    assistantBuffer += event.delta || "";
    render();
    return;
  }
  if (type === "conversation.item.input_audio_transcription.delta") {
    captionEl.textContent = event.delta || "";
  }
  if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
    const text = (event.transcript || assistantBuffer).trim();
    assistantBuffer = "";
    if (text) lines.push({ role: "assistant", text });
    render();
    scheduleSave();
    return;
  }
  if (
    type === "conversation.item.input_audio_transcription.completed" ||
    type === "conversation.item.input_audio_transcription.done"
  ) {
    const text = (event.transcript || "").trim();
    if (text) lines.push({ role: "user", text });
    render();
    scheduleSave();
  }
}

function beginNew() {
  if (session || starting) return;
  if (selectedIds().length === 0) {
    setStatus("Choose at least one skill");
    showScreen("skills");
    return;
  }
  const media = openMedia();
  if (!media) return;
  starting = true;
  updateStart();
  startPractice(media).finally(finishStart);
}

function beginContinue() {
  if (session || starting || !interviewId) return;
  const media = openMedia();
  if (!media) return;
  starting = true;
  updateStart();
  continuePractice(media).finally(finishStart);
}

function openMedia() {
  try {
    return prepareCall();
  } catch (error) {
    setStatus(callError(error));
    return null;
  }
}

function finishStart() {
  starting = false;
  updateStart();
}

function callError(error) {
  const name = error && error.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "Allow the microphone to start";
  if (name === "NotFoundError") return "No microphone found";
  return error instanceof Error ? error.message : "Could not connect";
}

async function startPractice(media) {
  const skillIds = selectedIds();
  if (skillIds.length === 0) {
    await media.cancel();
    setStatus("Choose at least one skill");
    showScreen("skills");
    return;
  }
  clearPanels();
  interviewId = "";
  markOpenSession();
  showScreen("conversation");
  setVoice("connecting");
  setStatus("Connecting");
  try {
    const created = await fetch("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillIds }),
    });
    const record = await created.json();
    if (!created.ok) throw new Error(record.error || "Could not open a session");
    interviewId = record.id;
    await connectCall([], media);
    loadSessions();
  } catch (error) {
    if (!session) await media.cancel();
    if (interviewId && lines.length === 0) {
      await fetch(`/sessions/${interviewId}`, { method: "DELETE" });
      interviewId = "";
    }
    setVoice("idle");
    setStatus(callError(error));
    setLive(false);
    loadSessions();
  }
}

async function continuePractice(media) {
  if (!interviewId) {
    await media.cancel();
    return;
  }
  showScreen("conversation");
  setVoice("connecting");
  setStatus("Connecting");
  try {
    await connectCall(lines.slice(-40), media);
    loadSessions();
  } catch (error) {
    if (!session) await media.cancel();
    setVoice("idle");
    setStatus(callError(error));
    setLive(false);
  }
}

async function connectCall(history, media) {
  session = await startSession({
    sessionId: interviewId,
    history,
    media,
    onEvent: handleEvent,
    onLevel: (level) => {
      if (voice !== "listening" && voice !== "speaking") return;
      orb.style.setProperty("--scale", String(1 + level * 0.22));
    },
  });
  setStatus("Live");
  setLive(true);
  setVoice(muted ? "muted" : "listening");
  limitTimer = window.setTimeout(() => {
    endInterview();
  }, LIMIT_MS);
}

async function endInterview() {
  window.clearTimeout(limitTimer);
  if (session) {
    session.askToClose();
    await wait(2500);
    if (assistantBuffer.trim()) {
      lines.push({ role: "assistant", text: assistantBuffer.trim() });
      assistantBuffer = "";
    }
    session.stop();
    session = null;
  }
  muted = false;
  muteButton.textContent = "Mute";
  setVoice("idle");
  setLive(false);
  setStatus("Writing debrief");
  render();
  await saveTranscript(true);
  try {
    const response = await fetch("/debrief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: lines, sessionId: interviewId }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Debrief failed");
    showDebrief(payload);
    setStatus("Ended");
    loadSkills();
    loadSessions();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Debrief failed");
    loadSkills();
    loadSessions();
  }
}

function render() {
  const visible = lines.slice();
  if (assistantBuffer.trim()) visible.push({ role: "assistant", text: assistantBuffer });
  transcriptEl.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "The conversation appears here once someone speaks.";
    transcriptEl.append(empty);
  } else {
    for (const line of visible) {
      const row = document.createElement("p");
      row.className = line.role === "user" ? "bubble you" : "bubble them";
      row.textContent = line.text;
      transcriptEl.append(row);
    }
  }
  if (voice === "speaking") captionEl.textContent = assistantBuffer.trim();
  else if (voice === "listening" && !assistantBuffer.trim()) captionEl.textContent = "Listening";
  threadEl.scrollTop = threadEl.scrollHeight;
}

function clearPanels() {
  lines = [];
  assistantBuffer = "";
  feedback = null;
  debriefEl.hidden = true;
  debriefEl.innerHTML = "";
  captionEl.textContent = "";
  render();
}

function showScreen(name) {
  const skills = name !== "conversation";
  skillsCard.hidden = !skills;
  conversationEl.hidden = skills;
  skillsTab.setAttribute("aria-selected", skills ? "true" : "false");
  conversationTab.setAttribute("aria-selected", skills ? "false" : "true");
}

function setVoice(next) {
  voice = next;
  orb.dataset.state = next;
  if (next === "speaking") session?.setDrive("assistant");
  else if (next === "listening") session?.setDrive("user");
  else session?.setDrive("quiet");
  if (next !== "listening" && next !== "speaking") orb.style.setProperty("--scale", "1");
  if (next === "listening") captionEl.textContent = "Listening";
  if (next === "idle" || next === "connecting" || next === "muted") captionEl.textContent = next === "muted" ? "Muted" : "";
}

function setLive(live) {
  document.body.classList.toggle("live", live);
  muteButton.disabled = !live;
  endButton.disabled = !live;
  if (live) debriefEl.hidden = true;
  else if (feedback) debriefEl.hidden = false;
  updateStart();
}

function selectedIds() {
  return [...treesEl.querySelectorAll("input[data-leaf]:checked")].map((input) => input.value);
}

function updateStart() {
  const count = selectedIds().length;
  const busy = Boolean(session) || starting;
  practiceButton.disabled = busy;
  startButton.disabled = busy;
  startButton.textContent = interviewId ? "Continue" : "Start";
  summaryEl.textContent = count === 0 ? "" : count === 1 ? "1 skill selected" : `${count} skills selected`;
}

function stateLabel(state) {
  if (state === "mastered") return "Mastered";
  if (state === "progress") return "In progress";
  return "Untouched";
}

function renderTrees(trees) {
  treesEl.replaceChildren();
  for (const tree of trees || []) {
    const block = document.createElement("section");
    block.className = "tree";
    const heading = document.createElement("h2");
    heading.textContent = tree.title;
    block.append(heading);
    if (tree.track === "yours" && (tree.groups || []).length === 0) {
      const note = document.createElement("p");
      note.className = "empty";
      note.textContent = "Topics you add show up here.";
      block.append(note);
    }
    for (const group of tree.groups || []) {
      const details = document.createElement("details");
      details.open = true;
      const summary = document.createElement("summary");
      const groupRow = document.createElement("span");
      groupRow.className = "row";
      const groupBox = document.createElement("input");
      groupBox.type = "checkbox";
      groupBox.addEventListener("click", (event) => event.stopPropagation());
      const leaves = [];
      const list = document.createElement("div");
      list.className = "leaves";
      for (const child of group.children || []) {
        const row = document.createElement("label");
        row.className = "row";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.leaf = "1";
        box.value = child.id;
        box.checked = Boolean(child.checked);
        const copy = document.createElement("span");
        copy.className = "leaf-copy";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = child.title;
        copy.append(name);
        if (child.gap && child.state !== "mastered") {
          const gap = document.createElement("span");
          gap.className = "gap";
          gap.textContent = child.gap;
          copy.append(gap);
        }
        const caption = document.createElement("span");
        caption.className = "caption";
        caption.textContent = child.streak ? `${stateLabel(child.state)} · ${child.streak} solid` : stateLabel(child.state);
        row.append(box, copy, caption);
        if (child.state === "mastered") {
          const pill = document.createElement("span");
          pill.className = "pill";
          pill.textContent = "Mastered";
          caption.hidden = true;
          row.append(pill);
        }
        if (child.custom) row.append(rowActions(child.id, name));
        list.append(row);
        const study = studyPanel(child.detail, child.reading);
        if (study) list.append(study);
        leaves.push(box);
      }
      groupBox.checked = leaves.length > 0 && leaves.every((box) => box.checked);
      groupBox.indeterminate = !groupBox.checked && leaves.some((box) => box.checked);
      const groupName = document.createElement("span");
      groupName.className = "name";
      groupName.textContent = group.title;
      const groupMeta = document.createElement("span");
      groupMeta.className = "leaf-copy";
      const groupCounts = document.createElement("span");
      groupCounts.className = "gap";
      groupCounts.textContent = countLine(group);
      groupMeta.append(groupName, groupCounts);
      groupRow.append(groupBox, groupMeta);
      if (group.custom) groupRow.append(rowActions(group.id, groupName));
      summary.append(groupRow);
      groupBox.addEventListener("change", () => {
        for (const box of leaves) box.checked = groupBox.checked;
        groupBox.indeterminate = false;
        updateStart();
        scheduleFocus();
      });
      for (const box of leaves) {
        box.addEventListener("change", () => {
          groupBox.checked = leaves.every((item) => item.checked);
          groupBox.indeterminate = !groupBox.checked && leaves.some((item) => item.checked);
          updateStart();
          scheduleFocus();
        });
      }
      details.append(summary);
      const groupStudy = studyPanel(group.detail, group.reading);
      if (groupStudy) details.append(groupStudy);
      details.append(list);
      if (group.custom) details.append(groupTopicForm(group.id));
      block.append(details);
    }
    treesEl.append(block);
  }
  updateStart();
}

function studyPanel(detail, reading) {
  const text = String(detail || "").trim();
  if (!text) return null;
  const panel = document.createElement("details");
  panel.className = "study";
  const summary = document.createElement("summary");
  summary.textContent = "Read";
  const body = document.createElement("div");
  body.className = "brief";
  const copy = document.createElement("p");
  copy.textContent = text;
  body.append(copy, linkList("Sources", reading?.sources), linkList("References", reading?.references));
  panel.append(summary, body);
  panel.addEventListener("click", (event) => event.stopPropagation());
  return panel;
}

function linkList(title, items) {
  const wrap = document.createElement("div");
  if (!Array.isArray(items) || items.length === 0) return wrap;
  const heading = document.createElement("h3");
  heading.textContent = title;
  const list = document.createElement("ul");
  for (const item of items) {
    const row = document.createElement("li");
    const link = document.createElement("a");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = item.title;
    row.append(link);
    list.append(row);
  }
  wrap.append(heading, list);
  return wrap;
}

function countLine(group) {
  const children = group.children || [];
  const mastered = children.filter((child) => child.mastered).length;
  const progress = children.filter((child) => child.state === "progress").length;
  const gaps = children.filter((child) => child.gap).length;
  return `${mastered} mastered · ${progress} in progress · ${gaps} ${gaps === 1 ? "gap" : "gaps"}`;
}

function rowActions(id, nameEl) {
  const actions = document.createElement("span");
  actions.className = "row-actions";
  const rename = document.createElement("button");
  rename.type = "button";
  rename.className = "text tiny";
  rename.textContent = "Rename";
  rename.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    beginRename(id, nameEl);
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "text tiny danger";
  remove.textContent = "Remove";
  remove.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const response = await fetch(`/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) return;
    const payload = await response.json();
    renderTrees(payload.trees);
  });
  actions.append(rename, remove);
  return actions;
}

function beginRename(id, nameEl) {
  const input = document.createElement("input");
  input.className = "rename";
  input.value = nameEl.textContent;
  nameEl.replaceWith(input);
  input.focus();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (!save || !title || title === nameEl.textContent) {
      input.replaceWith(nameEl);
      return;
    }
    const response = await fetch(`/skills/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      input.replaceWith(nameEl);
      return;
    }
    const payload = await response.json();
    renderTrees(payload.trees);
  };
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function groupTopicForm(groupId) {
  const form = document.createElement("form");
  form.className = "group-add";
  const input = document.createElement("input");
  input.maxLength = 120;
  input.placeholder = "Add to this group";
  input.autocomplete = "off";
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Add";
  form.append(input, button);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    addTopic(input.value, groupId);
  });
  return form;
}

function signedOut(response) {
  if (response.status !== 401) return false;
  showApp(false);
  loginStatus.textContent = "Sign in again";
  return true;
}

async function addTopic(topic, groupId) {
  const name = topic.trim();
  if (name.length < 2) return;
  researchStatus.textContent = `Researching ${name}…`;
  addTopicButton.disabled = true;
  topicInput.disabled = true;
  try {
    const response = await fetch("/skills/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: name, groupId }),
    });
    if (signedOut(response)) {
      researchStatus.textContent = "";
      return;
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not add that topic");
    topicInput.value = "";
    researchStatus.textContent = "";
    renderTrees(payload.trees);
  } catch (error) {
    researchStatus.textContent = error instanceof Error ? error.message : "Could not add that topic";
  } finally {
    addTopicButton.disabled = false;
    topicInput.disabled = false;
  }
}

function scheduleFocus() {
  window.clearTimeout(focusTimer);
  focusTimer = window.setTimeout(() => {
    fetch("/skills/focus", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: selectedIds() }),
    });
  }, 200);
}

async function loadSkills() {
  const response = await fetch("/skills");
  if (!response.ok) return;
  const payload = await response.json();
  renderTrees(payload.trees);
}

function showApp(signedIn) {
  loginEl.hidden = signedIn;
  appEl.hidden = !signedIn;
  if (!signedIn) {
    window.clearTimeout(limitTimer);
    window.clearTimeout(saveTimer);
    window.clearTimeout(focusTimer);
    interviewId = "";
    whoEl.textContent = "";
    treesEl.replaceChildren();
    sessionListEl.replaceChildren();
    setLive(false);
    setVoice("idle");
    setStatus("Ready");
    showScreen("skills");
  }
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTranscript(false);
  }, 700);
}

async function saveTranscript(ended) {
  if (!interviewId) return;
  await fetch(`/sessions/${interviewId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: lines, ended }),
  });
}

async function loadSessions() {
  const response = await fetch("/sessions");
  if (!response.ok) return;
  const payload = await response.json();
  sessionListEl.replaceChildren();
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Your interviews show up here after you start one.";
    sessionListEl.append(empty);
    return;
  }
  for (const item of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    const when = document.createElement("small");
    const started = new Date(item.startedAt);
    const names = Array.isArray(item.skills) && item.skills.length ? item.skills.join(", ") : item.track;
    when.textContent = `${names} · ${Number.isNaN(started.getTime()) ? item.startedAt : started.toLocaleString()}`;
    const preview = document.createElement("span");
    preview.className = "preview";
    preview.textContent = item.preview || "No transcript yet";
    button.dataset.id = item.id;
    if (item.id === interviewId) {
      button.classList.add("open");
      button.setAttribute("aria-current", "true");
    }
    button.append(when, preview);
    button.addEventListener("click", () => openSession(item.id));
    sessionListEl.append(button);
  }
}

function markOpenSession() {
  for (const button of sessionListEl.querySelectorAll("button")) {
    const open = button.dataset.id === interviewId;
    button.classList.toggle("open", open);
    if (open) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

async function openSession(id) {
  if (session) return;
  const response = await fetch(`/sessions/${id}`);
  const record = await response.json();
  if (!response.ok) {
    setStatus(record.error || "Could not open that session");
    return;
  }
  interviewId = record.id;
  markOpenSession();
  lines = Array.isArray(record.transcript) ? record.transcript : [];
  assistantBuffer = "";
  render();
  showDebrief(record.debrief ? { ...record.debrief, grades: record.grades } : record.grades?.length ? { grades: record.grades } : null);
  setVoice("idle");
  setStatus(record.endedAt ? "Saved session" : "Saved session, still open");
  showScreen("conversation");
  updateStart();
}

function showDebrief(debrief) {
  feedback = debrief && (debrief.strong || debrief.missing || debrief.outline || debrief.grades?.length || debrief.gaps?.length) ? debrief : null;
  if (!feedback) {
    debriefEl.hidden = true;
    debriefEl.innerHTML = "";
    return;
  }
  debriefEl.hidden = false;
  debriefEl.innerHTML = `
    <h3>What was strong</h3>
    <p>${escapeHtml(debrief.strong)}</p>
    <h3>What was missing</h3>
    <p>${escapeHtml(debrief.missing)}</p>
    <h3>A tighter answer</h3>
    <p>${escapeHtml(debrief.outline)}</p>
    ${gapList(debrief.gaps, debrief.grades)}
    ${gradeList(debrief.grades)}
  `;
  threadEl.scrollTop = threadEl.scrollHeight;
}

function gapList(gaps, grades) {
  const titles = new Map((grades || []).map((grade) => [grade.id, grade.title || grade.id]));
  const items = (Array.isArray(gaps) ? gaps : [])
    .filter((gap) => gap && gap.note)
    .map((gap) => `<li>${escapeHtml(titles.get(gap.id) || gap.id)}: ${escapeHtml(gap.note)}</li>`)
    .join("");
  if (!items) return "";
  return `<h3>Gaps</h3><ul class="notes">${items}</ul>`;
}

function gradeList(grades) {
  if (!Array.isArray(grades) || grades.length === 0) return "";
  const items = grades
    .map((grade) => `<li>${escapeHtml(grade.title || grade.id)}: ${escapeHtml(grade.rating)}</li>`)
    .join("");
  return `<h3>Skills</h3><ul class="notes">${items}</ul>`;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

render();
showApp(false);
fetch("/me").then(async (me) => {
  if (!me.ok) return;
  const payload = await me.json();
  whoEl.textContent = payload.email || "";
  showApp(true);
  loadSkills();
  loadSessions();
});

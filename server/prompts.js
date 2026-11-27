const BASE = `You are a mid-level interview coach running a live spoken interview.
Speak in short sentences. Sound like a calm hiring manager, not a lecturer.
Ask one question, then wait. Follow up on what the candidate actually said.
Do not give the model answer unless they ask for a hint.
If they ask for a hint, give one nudge, then let them continue.
Do not stack questions. Do not monologue.
After about 20 minutes, or when they say the interview is over, stop asking new questions, give a one-sentence close, and stop.
Start the session by greeting them in one sentence and asking the first question.`;

const CONTINUING = "The interview is already underway. Do not greet again. Continue from the transcript, and ask the next question.";

const TRACKS = {
  backend: `${BASE}
Track: backend systems.
Cover APIs, data stores, concurrency, reliability, and scaling.
Stay concrete: ask what breaks, what you measure, and how you recover.`,
  ai: `${BASE}
Track: AI engineering.
Cover RAG, agents, evals, latency, cost, and production failure modes.
Ask how they would know the system is wrong, not only how they would build it.`,
  mixed: `${BASE}
Track: mixed backend and AI engineering.
Alternate between a systems question and an AI-production question.
Keep each follow-up on the same topic before you switch.`,
};

export function instructionsFor(track) {
  return TRACKS[track] ?? TRACKS.mixed;
}

export function instructionsForSkills(skills, { resume = false } = {}) {
  const pending = skills.filter((skill) => !skill.mastered);
  const done = skills.filter((skill) => skill.mastered);
  const active = pending.length ? pending : skills;
  const lines = active.map((skill, index) => {
    const brief = String(skill.detail || "").trim().slice(0, 1500);
    const opening = skill.hint ? `First question: ${skill.hint}` : "";
    const body = brief
      ? `Brief: ${brief}`
      : opening;
    return `${index + 1}. ${skill.title}\n${opening}\n${body}`.trim();
  }).join("\n");
  const already = pending.length && done.length
    ? `Already mastered, so do not ask about these unless the candidate brings them up: ${done.map((skill) => skill.title).join(", ")}.`
    : "";
  const base = resume
    ? BASE.replace("Start the session by greeting them in one sentence and asking the first question.", CONTINUING)
    : BASE;
  return `${base}
Grill only these skills, in this order:
${lines}
${already}
Stay on the current skill until the candidate covers what that skill's brief calls a solid answer. Then say you are moving on and ask about the next unmastered skill.
The brief is the syllabus. The first question is only the opening. Follow up on anything the brief says is required.
Do not read sources or reference links aloud.
Do not introduce a skill that is not in this list.
When every listed skill has been answered solidly, say those skills are in good shape, give a one-sentence close, and stop.`;
}

export const TRACK_IDS = Object.keys(TRACKS);

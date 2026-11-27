const GROUPS = [
  ["backend.apis", "backend", "APIs", 10],
  ["backend.data", "backend", "Data stores", 20],
  ["backend.concurrency", "backend", "Concurrency", 30],
  ["backend.reliability", "backend", "Reliability", 40],
  ["backend.scaling", "backend", "Scaling", 50],
  ["ai.rag", "ai", "RAG", 60],
  ["ai.agents", "ai", "Agents", 70],
  ["ai.evals", "ai", "Evals", 80],
  ["ai.latency", "ai", "Latency and cost", 90],
  ["ai.failures", "ai", "Production failures", 100],
];

const LEAVES = [
  ["backend.apis.contracts", "backend.apis", "Contracts", "Ask how they design a request and response contract, and what breaks for clients when it changes."],
  ["backend.apis.idempotency", "backend.apis", "Idempotency", "Ask what happens when the same request is delivered twice, and how they make the write safe."],
  ["backend.apis.pagination", "backend.apis", "Pagination", "Ask how a list endpoint stays stable when rows are inserted while a client is paging."],
  ["backend.data.indexes", "backend.data", "Indexes", "Ask which index they would add for a slow query, and what that index costs on writes."],
  ["backend.data.transactions", "backend.data", "Transactions", "Ask which statements must commit or roll back together, and what isolation they need."],
  ["backend.data.consistency", "backend.data", "Consistency", "Ask what a reader can observe after a write, and where stale data is acceptable."],
  ["backend.concurrency.locks", "backend.concurrency", "Locks", "Ask what they lock, how long they hold it, and what happens when two workers collide."],
  ["backend.concurrency.queues", "backend.concurrency", "Queues", "Ask how work is handed off, how they retry, and how they avoid processing one job twice."],
  ["backend.concurrency.backpressure", "backend.concurrency", "Backpressure", "Ask what they do when producers outrun consumers, and what the caller sees."],
  ["backend.reliability.timeouts", "backend.reliability", "Timeouts", "Ask where they set a deadline, and what the caller does when it fires."],
  ["backend.reliability.retries", "backend.reliability", "Retries", "Ask which errors are retried, with what backoff, and which retries would duplicate a side effect."],
  ["backend.reliability.isolation", "backend.reliability", "Failure isolation", "Ask how one bad dependency stops affecting the rest of the request path."],
  ["backend.scaling.caching", "backend.scaling", "Caching", "Ask what they cache, how they invalidate it, and what a stale cache does to users."],
  ["backend.scaling.partitioning", "backend.scaling", "Partitioning", "Ask how they split data or traffic, and which operation becomes harder after the split."],
  ["backend.scaling.shedding", "backend.scaling", "Load shedding", "Ask what they drop or refuse when the service is past its limit, and who gets served first."],
  ["ai.rag.chunking", "ai.rag", "Chunking", "Ask how they split documents, and what answer gets worse when a chunk boundary cuts a fact in half."],
  ["ai.rag.retrieval", "ai.rag", "Retrieval", "Ask how they know the right passage was fetched, and what they do when the top hits are irrelevant."],
  ["ai.rag.grounding", "ai.rag", "Grounding", "Ask how the answer stays tied to retrieved text, and how a user can tell a claim was not in the source."],
  ["ai.agents.tools", "ai.agents", "Tool use", "Ask how the model chooses a tool, and what they do when the tool returns an error or a huge payload."],
  ["ai.agents.planning", "ai.agents", "Planning", "Ask how a multi-step task is broken up, and how they stop the model from skipping a step."],
  ["ai.agents.loops", "ai.agents", "Stuck loops", "Ask how they detect an agent repeating itself, and what limit ends the run."],
  ["ai.evals.datasets", "ai.evals", "Datasets", "Ask what examples belong in an eval set, and how they keep that set from leaking into prompts."],
  ["ai.evals.judges", "ai.evals", "Judges", "Ask how they score an answer, and how they check that the judge itself is wrong."],
  ["ai.evals.regressions", "ai.evals", "Regressions", "Ask how a prompt or model change is blocked when quality drops on a known case."],
  ["ai.latency.batching", "ai.latency", "Batching", "Ask what work they batch, and what latency the user pays for a fuller batch."],
  ["ai.latency.caching", "ai.latency", "Caching", "Ask which model outputs are safe to reuse, and when a cached answer becomes wrong."],
  ["ai.latency.models", "ai.latency", "Model choice", "Ask how they pick a smaller or larger model, and what quality they are willing to lose."],
  ["ai.failures.detection", "ai.failures", "Detecting wrong answers", "Ask how production traffic shows that an answer is wrong before a user complains."],
  ["ai.failures.injection", "ai.failures", "Prompt injection", "Ask how untrusted text can steer the model, and what tool or data access they refuse it."],
  ["ai.failures.drift", "ai.failures", "Drift", "Ask how they notice the input mix or the model's behavior has moved, and what they compare against."],
];

export const SKILLS = [
  ...GROUPS.map(([id, track, title, sort]) => ({ id, track, parentId: null, title, hint: "", sort })),
  ...LEAVES.map(([id, parentId, title, hint], index) => ({
    id,
    track: parentId.startsWith("ai.") ? "ai" : "backend",
    parentId,
    title,
    hint,
    sort: index,
  })),
];

const BY_ID = new Map(SKILLS.map((skill) => [skill.id, skill]));

export function skillById(id) {
  return BY_ID.get(id) || null;
}

export function isLeaf(id) {
  const skill = BY_ID.get(id);
  return Boolean(skill && skill.parentId);
}

export function leaves() {
  return SKILLS.filter((skill) => skill.parentId);
}

export const TRACK_TITLES = {
  backend: "Backend systems",
  ai: "AI engineering",
};

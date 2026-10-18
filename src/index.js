// ============================================================
// REDDIT EMPLOYEE WORKER
// Cloudflare Workers + Supabase + Composio
// NO AI. Dynamic tasks. One post per execution.
// ============================================================

const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3.1";
const DEFAULT_TOOLKIT_VERSION = "20261014_00";

const MAX_POST_AGE_DAYS = 90;
const SEARCH_RESULT_LIMIT = 100;
const MIN_RELEVANCE_SCORE = 20;

// ============================================================
// RESPONSE HELPERS
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// ============================================================
// SUPABASE REST HELPER
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  const response = await fetch(
    `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let result;

  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase error ${response.status}: ${JSON.stringify(result)}`
    );
  }

  return result;
}

// ============================================================
// COMPOSIO TOOL EXECUTION
// ============================================================

async function executeComposioTool(
  env,
  connectionId,
  toolSlug,
  args
) {
  const version =
    env.COMPOSIO_REDDIT_TOOLKIT_VERSION ||
    DEFAULT_TOOLKIT_VERSION;

  const response = await fetch(
    `${COMPOSIO_API_BASE}/tools/execute/${toolSlug}`,
    {
      method: "POST",
      headers: {
        "x-api-key": env.COMPOSIO_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        connected_account_id: connectionId,
        version,
        arguments: args
      })
    }
  );

  const text = await response.text();

  let result;

  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Composio returned invalid JSON");
  }

  if (
    !response.ok ||
    result.successful === false ||
    result.error
  ) {
    throw new Error(
      `Composio ${toolSlug} error: ${JSON.stringify(result.error || result)}`
    );
  }

  return result;
}

// ============================================================
// PARSE DYNAMIC TASK
// Supports the text format you provided.
// ============================================================

function cleanSubreddit(value) {
  return String(value || "")
    .trim()
    .replace(/^r\//i, "")
    .replace(/^\/+/, "");
}

function parseTask(taskText) {
  if (!taskText || typeof taskText !== "string") {
    throw new Error("Task text is empty");
  }

  // JSON task support.
  try {
    const obj = JSON.parse(taskText);

    if (obj && typeof obj === "object") {
      return {
        niche: obj.customer_niche || obj.niche || null,
        subreddits: Array.isArray(obj.subreddits)
          ? obj.subreddits.map(cleanSubreddit)
          : null,
        queries: Array.isArray(obj.search_queries)
          ? obj.search_queries
          : Array.isArray(obj.queries)
            ? obj.queries
            : null,
        objective: obj.objective || ""
      };
    }
  } catch {
    // Continue with text parsing.
  }

  const lines = taskText.split(/\r?\n/);

  let niche = null;
  let objective = "";
  let section = null;

  const subreddits = [];
  const queries = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) continue;

    if (/^Customer Niche:/i.test(line)) {
      niche = line.replace(/^Customer Niche:/i, "").trim();
      section = null;
      continue;
    }

    if (/^Objective:/i.test(line)) {
      objective = line.replace(/^Objective:/i, "").trim();
      section = null;
      continue;
    }

    if (/^Recommended Subreddits:/i.test(line)) {
      section = "subreddits";
      continue;
    }

    if (/^Search Queries:/i.test(line)) {
      section = "queries";
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);

    if (bullet && section === "subreddits") {
      subreddits.push(cleanSubreddit(bullet[1]));
    } else if (bullet && section === "queries") {
      queries.push(bullet[1].trim());
    }
  }

  return {
    niche,
    objective,
    subreddits,
    queries
  };
}

// ============================================================
// CLAIM LATEST TASK
// ============================================================

async function claimLatestTask(env) {
  const params = new URLSearchParams({
    select: "id,application_id,user_id,worker_type,source,task,pending_count,status,niche,created_at",
    worker_type: "eq.reddit_research",
    source: "eq.reddit",
    pending_count: "gt.0",
    status: "in.(pending,Pending)",
    order: "created_at.desc",
    limit: "1"
  });

  const tasks = await supabaseRequest(
    env,
    `planner_runs?${params.toString()}`
  );

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return null;
  }

  const task = tasks[0];

  // Optimistic claim: update only if the task still has
  // the status and count we just read.
  const claimParams = new URLSearchParams({
    id: `eq.${task.id}`,
    pending_count: `eq.${task.pending_count}`,
    status: "in.(pending,Pending)",
    select: "id,application_id,user_id,worker_type,source,task,pending_count,status,niche,created_at"
  });

  const claimed = await supabaseRequest(
    env,
    `planner_runs?${claimParams.toString()}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        status: "processing",
        started_at: new Date().toISOString(),
        error: null
      })
    }
  );

  return Array.isArray(claimed) && claimed.length
    ? claimed[0]
    : null;
}

// ============================================================
// GET COMPOSIO CONNECTION
// No REDDIT_INTEGRATION_ID environment variable.
// ============================================================

async function getRedditConnection(env, task) {
  if (!task.user_id || !task.application_id) {
    throw new Error("Task is missing user_id or application_id");
  }

  const userId = String(task.user_id);

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(userId)) {
    throw new Error(
      "planner_runs.user_id must be a UUID matching user_integrations.user_id"
    );
  }

  const params = new URLSearchParams({
    select: "id,user_id,integration_id,connection_id,status,application_id,updated_at",
    user_id: `eq.${userId}`,
    application_id: `eq.${task.application_id}`,
    status: "eq.active",
    order: "updated_at.desc",
    limit: "20"
  });

  const integrations = await supabaseRequest(
    env,
    `user_integrations?${params.toString()}`
  );

  if (!Array.isArray(integrations)) {
    throw new Error("Invalid user_integrations response");
  }

  // Find the Reddit integration by its integration_id value.
  const connection = integrations.find(row =>
    String(row.integration_id || "")
      .toLowerCase()
      .includes("reddit") &&
    row.connection_id
  );

  if (!connection) {
    throw new Error(
      "No active Reddit connection found for this user and application"
    );
  }

  return connection.connection_id;
}

// ============================================================
// EXTRACT REAL REDDIT POSTS
// ============================================================

function extractPosts(response) {
  const found = new Map();
  const visited = new Set();

  function visit(value, depth = 0) {
    if (
      !value ||
      typeof value !== "object" ||
      depth > 12 ||
      visited.has(value)
    ) {
      return;
    }

    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }

    const title =
      typeof value.title === "string"
        ? value.title.trim()
        : "";

    const permalink =
      typeof value.permalink === "string"
        ? value.permalink
        : "";

    const createdUtc = Number(
      value.created_utc ?? value.created
    );

    const rawId = String(value.id || value.name || "");

    if (
      title &&
      permalink &&
      Number.isFinite(createdUtc) &&
      createdUtc > 0 &&
      rawId
    ) {
      const id = rawId.startsWith("t3_")
        ? rawId.slice(3)
        : rawId;

      found.set(id, {
        id,
        title,
        selftext: String(value.selftext || ""),
        subreddit: cleanSubreddit(value.subreddit),
        permalink,
        author: String(value.author || ""),
        created_utc: createdUtc,
        score: Number(value.score) || 0,
        num_comments: Number(value.num_comments) || 0
      });
    }

    for (const child of Object.values(value)) {
      visit(child, depth + 1);
    }
  }

  visit(response);

  return [...found.values()];
}

// ============================================================
// RULE-BASED RELEVANCE
// No AI.
// ============================================================

function calculateRelevance(post, niche, query) {
  const content =
    `${post.title} ${post.selftext}`.toLowerCase();

  const tokenize = text =>
    String(text || "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [];

  const stopWords = new Set([
    "the", "and", "for", "with", "from", "that",
    "this", "are", "was", "were", "have", "has",
    "how", "what", "when", "where", "who", "why",
    "can", "you", "your", "their", "they", "into",
    "about", "need", "looking", "find", "new"
  ]);

  const nicheWords = tokenize(niche).filter(
    word => word.length > 2 && !stopWords.has(word)
  );

  const queryWords = tokenize(query).filter(
    word => word.length > 2 && !stopWords.has(word)
  );

  const agencyTerms = [
    "saas", "founder", "startup", "customer",
    "customers", "paying", "client", "clients",
    "business", "revenue", "subscription", "product"
  ];

  const nicheMatches = nicheWords.filter(
    word => content.includes(word)
  ).length;

  const queryMatches = queryWords.filter(
    word => content.includes(word)
  ).length;

  const contextMatches = agencyTerms.filter(
    word => content.includes(word)
  ).length;

  const nicheScore = nicheWords.length
    ? 30 * nicheMatches / nicheWords.length
    : 0;

  const queryScore = queryWords.length
    ? 50 * queryMatches / queryWords.length
    : 0;

  const contextScore = contextMatches >= 2
    ? 20
    : contextMatches === 1
      ? 10
      : 0;

  return Math.min(
    100,
    Math.round(nicheScore + queryScore + contextScore)
  );
}

// ============================================================
// SAVE POST THEN DECREMENT COUNTER
// No SQL RPC or migration required.
// ============================================================

async function savePost(env, task, post, query, niche, relevance) {
  const result = await supabaseRequest(
    env,
    "reddit_research_results",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation,resolution=ignore-duplicates"
      },
      body: JSON.stringify({
        user_id: task.user_id,
        application_id: task.application_id,
        planner_id: task.id,
        reddit_post_id: post.id,
        subreddit: post.subreddit,
        title: post.title,
        post_text: post.selftext,
        post_url: post.permalink.startsWith("http")
          ? post.permalink
          : `https://www.reddit.com${post.permalink}`,
        author_username: post.author,
        created_utc: Math.floor(post.created_utc),
        score: post.score,
        num_comments: post.num_comments,
        customer_niche: niche,
        matched_query: query,
        relevance_score: relevance
      })
    }
  );

  // With ignore-duplicates, a duplicate may return an empty array.
  if (!Array.isArray(result) || result.length === 0) {
    return { saved: false, duplicate: true };
  }

  // Update the task counter only after a new result is inserted.
  const newCount = Number(task.pending_count) - 1;
  const newStatus = newCount === 0 ? "Completed" : "pending";

  const params = new URLSearchParams({
    id: `eq.${task.id}`,
    status: "eq.processing",
    pending_count: `eq.${task.pending_count}`,
    select: "id,pending_count,status"
  });

  const updated = await supabaseRequest(
    env,
    `planner_runs?${params.toString()}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        pending_count: newCount,
        status: newStatus,
        error: null
      })
    }
  );

  if (!Array.isArray(updated) || updated.length === 0) {
    throw new Error(
      "Post saved, but task counter update failed. Reconciliation is required."
    );
  }

  return {
    saved: true,
    pending_count: newCount,
    status: newStatus
  };
}

// ============================================================
// RESTORE TASK FOR RETRY
// ============================================================

async function retryTask(env, task, message) {
  const params = new URLSearchParams({
    id: `eq.${task.id}`,
    status: "eq.processing"
  });

  try {
    await supabaseRequest(
      env,
      `planner_runs?${params.toString()}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "pending",
          error: String(message).slice(0, 2000)
        })
      }
    );
  } catch (error) {
    console.error("Unable to restore task:", error.message);
  }
}

// ============================================================
// EXECUTE ONE TASK
// ============================================================

async function processTask(env, task) {
  const parsed = parseTask(task.task);

  const subreddits = parsed.subreddits || [];
  const queries = parsed.queries || [];

  const niche = task.niche || parsed.niche;

  if (!niche) {
    throw new Error("Customer niche is missing");
  }

  if (!subreddits.length || !queries.length) {
    throw new Error(
      "Task must contain Recommended Subreddits and Search Queries"
    );
  }

  const count = Number(task.pending_count);

  if (!Number.isInteger(count) || count < 1 || count > 5) {
    throw new Error(`Invalid pending_count: ${task.pending_count}`);
  }

  const index = 5 - count;
  const query = queries[index];

  if (!query) {
    throw new Error(`No query for pending_count ${count}`);
  }

  const connectionId = await getRedditConnection(env, task);

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - MAX_POST_AGE_DAYS * 86400;

  // Use the primary subreddit associated with this count first.
  // If no qualifying post exists, try the next subreddit
  // with the same query.
  for (let offset = 0; offset < subreddits.length; offset++) {
    const subreddit =
      subreddits[(index + offset) % subreddits.length];

    const searchResponse = await executeComposioTool(
      env,
      connectionId,
      "REDDIT_SEARCH_ACROSS_SUBREDDITS",
      {
        query,
        subreddit,
        sort: "new",
        time_filter: "all",
        limit: SEARCH_RESULT_LIMIT
      }
    );

    const candidates = extractPosts(searchResponse)
      .filter(post => {
        return (
          post.created_utc >= cutoff &&
          post.created_utc <= now &&
          post.subreddit.toLowerCase() === subreddit.toLowerCase()
        );
      })
      .map(post => ({
        ...post,
        relevance: calculateRelevance(post, niche, query)
      }))
      .filter(post => post.relevance >= MIN_RELEVANCE_SCORE)
      .sort((a, b) => b.created_utc - a.created_utc);

    for (const post of candidates) {
      const saved = await savePost(
        env,
        task,
        post,
        query,
        niche,
        post.relevance
      );

      if (saved.duplicate) {
        continue;
      }

      return {
        success: true,
        task_id: task.id,
        reddit_post_id: post.id,
        subreddit: post.subreddit,
        title: post.title,
        post_url: post.permalink.startsWith("http")
          ? post.permalink
          : `https://www.reddit.com${post.permalink}`,
        matched_query: query,
        pending_count: saved.pending_count,
        status: saved.status
      };
    }
  }

  // No qualifying post: do not decrement pending_count.
  await retryTask(
    env,
    task,
    `No suitable post found for "${query}" in the last 90 days`
  );

  return {
    success: false,
    task_id: task.id,
    message: "No suitable post found; task remains pending",
    matched_query: query
  };
}

// ============================================================
// WORKER ENTRY POINT
// Supabase Cron calls POST /cron.
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        worker: "reddit-employee-worker",
        ai_enabled: false
      });
    }

    if (url.pathname !== "/cron") {
      return jsonResponse({ error: "Not found" }, 404);
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Use POST" }, 405);
    }

    for (const key of [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "COMPOSIO_API_KEY"
    ]) {
      if (!env[key]) {
        return jsonResponse(
          { error: `Missing secret: ${key}` },
          500
        );
      }
    }

    let task = null;

    try {
      task = await claimLatestTask(env);

      if (!task) {
        return jsonResponse({
          success: true,
          message: "No pending Reddit task"
        });
      }

      return jsonResponse(
        await processTask(env, task)
      );
    } catch (error) {
      console.error("Worker error:", error.message);

      if (task) {
        await retryTask(env, task, error.message);
      }

      return jsonResponse({
        success: false,
        task_id: task?.id || null,
        error: error.message
      }, 500);
    }
  }
};

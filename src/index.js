// ============================================================
// REDDIT TASK EMPLOYEE
// Cloudflare Worker
//
// Routes:
//   GET  /health
//   POST /cron
//
// Required Cloudflare secrets:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   COMPOSIO_API_KEY
//
// No AI is used.
// ============================================================

const WORKER_NAME = "reddit-task-employee";

const COMPOSIO_API_BASE =
  "https://backend.composio.dev/api/v3.1";

const REDDIT_SEARCH_TOOL =
  "REDDIT_SEARCH_ACROSS_SUBREDDITS";

const TOTAL_POSTS_PER_TASK = 5;
const MAX_POST_AGE_DAYS = 90;
const MAX_SEARCH_RESULTS = 100;
const MIN_RELEVANCE_SCORE = 15;

// A task left in processing for this long can be reclaimed.
const STALE_PROCESSING_MINUTES = 15;

// ============================================================
// HTTP RESPONSE HELPERS
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

// ============================================================
// SUPABASE REST API HELPER
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  const baseUrl = env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!baseUrl || !serviceKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY secret"
    );
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",

    headers: {
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },

    body:
      options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
  });

  const text = await response.text();

  let result = null;

  if (text) {
    try {
      result = JSON.parse(text);
    } catch {
      result = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${options.method || "GET"} failed ` +
      `(${response.status}): ` +
      `${typeof result === "string"
        ? result
        : JSON.stringify(result)}`
    );
  }

  return {
    data: result,
    headers: response.headers,
  };
}

// ============================================================
// COMPOSIO TOOL EXECUTION
// ============================================================

async function executeComposioTool(
  env,
  connectionId,
  toolSlug,
  argumentsObject
) {
  if (!env.COMPOSIO_API_KEY) {
    throw new Error("Missing COMPOSIO_API_KEY secret");
  }

  if (!connectionId) {
    throw new Error("Reddit connection ID is missing");
  }

  const url =
    `${COMPOSIO_API_BASE}/tools/execute/` +
    encodeURIComponent(toolSlug);

  const response = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.COMPOSIO_API_KEY,
    },

    body: JSON.stringify({
      connected_account_id: connectionId,
      version: "latest",
      arguments: argumentsObject,
    }),
  });

  const text = await response.text();

  let result;

  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Composio returned invalid JSON: ${text.slice(0, 500)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Composio tool ${toolSlug} failed ` +
      `(${response.status}): ` +
      JSON.stringify(result).slice(0, 1200)
    );
  }

  if (result.successful === false) {
    throw new Error(
      `Composio tool ${toolSlug} failed: ` +
      JSON.stringify(result.error || result).slice(0, 1200)
    );
  }

  if (result.error && !result.data) {
    throw new Error(
      `Composio tool ${toolSlug} failed: ` +
      JSON.stringify(result.error).slice(0, 1200)
    );
  }

  return result;
}

// ============================================================
// FIND THE REDDIT CONNECTION
//
// Important:
// Your actual database uses status = "connected".
// We also accept "active" for compatibility.
// ============================================================

async function getRedditConnection(env, task) {
  if (!task.user_id || !task.application_id) {
    throw new Error(
      "The task must contain user_id and application_id"
    );
  }

  const params = new URLSearchParams({
    select:
      "id,user_id,application_id,integration_id," +
      "connection_id,status",

    user_id: `eq.${task.user_id}`,

    application_id: `eq.${task.application_id}`,

    order: "updated_at.desc",
    limit: "50",
  });

  const response = await supabaseRequest(
    env,
    `/rest/v1/user_integrations?${params.toString()}`
  );

  const rows = response.data;

  if (!Array.isArray(rows)) {
    throw new Error(
      "Unexpected response when reading user_integrations"
    );
  }

  const connection = rows.find((row) => {
    const integration = String(
      row.integration_id || ""
    ).toLowerCase();

    const status = String(
      row.status || ""
    ).toLowerCase();

    return (
      integration === "reddit" &&
      Boolean(row.connection_id) &&
      ["connected", "active"].includes(status)
    );
  });

  if (!connection) {
    throw new Error(
      "No connected Reddit integration found for " +
      `user_id=${task.user_id}, ` +
      `application_id=${task.application_id}. ` +
      `Matching integration rows found: ${rows.length}.`
    );
  }

  return connection.connection_id;
}

// ============================================================
// PARSE TASK CONTENT
//
// Supported text format:
//
// Customer Niche: Marketing agencies
//
// Recommended Subreddits:
// - r/marketing
// - r/small-business
//
// Search Queries:
// - finding new clients consistently
// - client onboarding challenges
//
// The worker does not hardcode niche-specific subreddits
// or search queries.
// ============================================================

function extractSectionBullets(text, heading) {
  const lines = String(text || "").split(/\r?\n/);

  const headingRegex = new RegExp(
    `^\\s*${heading}\\s*:\\s*$`,
    "i"
  );

  let startIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (headingRegex.test(lines[i].trim())) {
      startIndex = i + 1;
      break;
    }
  }

  if (startIndex === -1) {
    return [];
  }

  const result = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();

    // Stop at the next heading, such as "Search Queries:"
    if (
      /^[A-Za-z][A-Za-z0-9 _()/.-]{0,60}:\s*$/.test(line)
    ) {
      break;
    }

    const bulletMatch = line.match(/^[-*•]\s*(.+)$/);

    if (bulletMatch) {
      result.push(bulletMatch[1].trim());
    }
  }

  return result;
}

function parseTask(task) {
  const taskContent = task.task;

  // Also support a JSON task payload.
  if (
    taskContent &&
    typeof taskContent === "object" &&
    !Array.isArray(taskContent)
  ) {
    const niche =
      task.niche ||
      taskContent.niche ||
      taskContent.customer_niche ||
      "";

    const subreddits =
      taskContent.subreddits ||
      taskContent.recommended_subreddits ||
      [];

    const queries =
      taskContent.queries ||
      taskContent.search_queries ||
      [];

    return {
      niche: String(niche).trim(),

      subreddits: normalizeSubreddits(subreddits),

      queries: normalizeQueries(queries),
    };
  }

  const text = String(taskContent || "");

  const nicheMatch = text.match(
    /^\s*Customer\s+Niche\s*:\s*(.+?)\s*$/im
  );

  const niche = String(
    task.niche || nicheMatch?.[1] || ""
  ).trim();

  const subreddits = extractSectionBullets(
    text,
    "Recommended Subreddits"
  );

  const queries = extractSectionBullets(
    text,
    "Search Queries"
  );

  return {
    niche,

    subreddits: normalizeSubreddits(subreddits),

    queries: normalizeQueries(queries),
  };
}

function normalizeSubreddits(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values
        .map((value) => {
          let name = String(value || "").trim();

          name = name.replace(/^https?:\/\/(www\.)?reddit\.com\/r\//i, "");
          name = name.replace(/^r\//i, "");
          name = name.replace(/^\/+|\/+$/g, "");

          // Keep just the subreddit name.
          name = name.split("/")[0].trim();

          return name;
        })
        .filter(Boolean)
    ),
  ];
}

function normalizeQueries(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ),
  ];
}

// ============================================================
// CLAIM THE LATEST ELIGIBLE TASK
//
// The task is claimed with an optimistic PATCH.
// A stale processing task can be reclaimed after 15 minutes.
// ============================================================

async function getCandidateTasks(env) {
  const params = new URLSearchParams({
    select:
      "id,application_id,user_id,worker_type,source," +
      "task,pending_count,error,niche,created_at," +
      "started_at,status",

    worker_type: "eq.reddit_research",

    source: "eq.reddit",

    pending_count: "gt.0",

    order: "created_at.desc",

    limit: "50",
  });

  const response = await supabaseRequest(
    env,
    `/rest/v1/planner_runs?${params.toString()}`
  );

  if (!Array.isArray(response.data)) {
    throw new Error("Unexpected planner_runs response");
  }

  return response.data;
}

function isStaleProcessingTask(task) {
  const status = String(task.status || "").toLowerCase();

  if (status !== "processing") {
    return false;
  }

  if (!task.started_at) {
    return true;
  }

  const startedAt = Date.parse(task.started_at);

  if (!Number.isFinite(startedAt)) {
    return true;
  }

  const staleBefore =
    Date.now() -
    STALE_PROCESSING_MINUTES * 60 * 1000;

  return startedAt < staleBefore;
}

function isEligibleTask(task) {
  const status = String(task.status || "").toLowerCase();

  if (Number(task.pending_count) <= 0) {
    return false;
  }

  return (
    status === "pending" ||
    isStaleProcessingTask(task)
  );
}

async function claimTask(env, task) {
  const previousStatus = String(
    task.status || ""
  ).toLowerCase();

  const params = new URLSearchParams({
    id: `eq.${task.id}`,

    pending_count: `eq.${task.pending_count}`,

    select: "*",
  });

  if (previousStatus === "processing") {
    // Only reclaim it if its processing lease is stale.
    const staleBefore = new Date(
      Date.now() -
      STALE_PROCESSING_MINUTES * 60 * 1000
    ).toISOString();

    params.set("status", `eq.${task.status}`);

    params.set("started_at", `lt.${staleBefore}`);
  } else if (task.status == null) {
    params.set("status", "is.null");
  } else {
    params.set("status", `eq.${task.status}`);
  }

  const response = await supabaseRequest(
    env,
    `/rest/v1/planner_runs?${params.toString()}`,
    {
      method: "PATCH",

      headers: {
        "Prefer": "return=representation",
      },

      body: {
        status: "processing",
        started_at: new Date().toISOString(),
        error: null,
      },
    }
  );

  const rows = response.data;

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return rows[0];
}

async function claimLatestTask(env) {
  const candidates = await getCandidateTasks(env);

  for (const candidate of candidates) {
    if (!isEligibleTask(candidate)) {
      continue;
    }

    const claimed = await claimTask(env, candidate);

    if (claimed) {
      return claimed;
    }
  }

  return null;
}

// ============================================================
// EXTRACT ACTUAL REDDIT POSTS FROM COMPOSIO RESPONSES
//
// Reddit search results may be nested inside data.children,
// posts, results, or another response wrapper.
// ============================================================

function subredditFromPermalink(permalink) {
  const match = String(permalink || "").match(
    /\/r\/([^/]+)\/comments\//i
  );

  return match ? match[1] : "";
}

function normalizePost(object) {
  if (!object || typeof object !== "object") {
    return null;
  }

  const title = object.title;

  const permalink = object.permalink;

  const createdUtc = Number(
    object.created_utc ??
    object.createdUtc ??
    object.created
  );

  const rawId = String(
    object.id ||
    object.post_id ||
    object.name ||
    ""
  ).trim();

  if (
    !title ||
    !permalink ||
    !rawId ||
    !Number.isFinite(createdUtc) ||
    createdUtc <= 0
  ) {
    return null;
  }

  // Convert fullname t3_abc123 to post ID abc123.
  const postId = rawId.replace(/^t3_/, "");

  let postUrl = String(permalink).trim();

  if (postUrl.startsWith("/")) {
    postUrl = `https://www.reddit.com${postUrl}`;
  }

  const subreddit = String(
    object.subreddit ||
    subredditFromPermalink(postUrl) ||
    ""
  ).replace(/^r\//i, "").trim();

  if (!subreddit) {
    return null;
  }

  return {
    id: postId,

    subreddit,

    title: String(title).trim(),

    postText: String(
      object.selftext ??
      object.post_text ??
      object.body ??
      ""
    ),

    postUrl,

    author: String(
      object.author ||
      object.author_username ||
      ""
    ),

    createdUtc: Math.floor(createdUtc),

    score: Number.isFinite(Number(object.score))
      ? Math.trunc(Number(object.score))
      : 0,

    numComments: Number.isFinite(
      Number(object.num_comments ?? object.numComments)
    )
      ? Math.trunc(
          Number(object.num_comments ?? object.numComments)
        )
      : 0,
  };
}

function extractPosts(response) {
  const found = new Map();
  const visited = new Set();

  function walk(value, depth = 0) {
    if (
      value == null ||
      depth > 15 ||
      typeof value !== "object"
    ) {
      return;
    }

    if (visited.has(value)) {
      return;
    }

    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }

      return;
    }

    const post = normalizePost(value);

    if (post) {
      found.set(post.id, post);
    }

    // Handle Reddit API-style listings.
    if (Array.isArray(value.children)) {
      for (const child of value.children) {
        if (child && child.data) {
          walk(child.data, depth + 1);
        } else {
          walk(child, depth + 1);
        }
      }
    }

    // Handle other Composio response wrappers.
    for (const [key, child] of Object.entries(value)) {
      if (key === "children") {
        continue;
      }

      if (child && typeof child === "object") {
        walk(child, depth + 1);
      }
    }
  }

  walk(response);

  return [...found.values()];
}

// ============================================================
// DATE FILTER
// ============================================================

function isWithinLast90Days(post) {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const cutoffSeconds =
    nowSeconds -
    MAX_POST_AGE_DAYS * 24 * 60 * 60;

  return (
    post.createdUtc >= cutoffSeconds &&
    post.createdUtc <= nowSeconds + 300
  );
}

// ============================================================
// RULE-BASED RELEVANCE SCORING
//
// No AI. The niche and query are taken from the task.
// ============================================================

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that",
  "this", "what", "when", "where", "which",
  "who", "how", "why", "are", "was", "were",
  "have", "has", "had", "can", "could", "would",
  "should", "into", "about", "your", "you", "our",
  "their", "they", "them", "its", "than", "then",
  "not", "but", "all", "any", "use", "using",
  "without", "before", "after", "more", "most",
  "ways", "way", "best", "need", "looking",
]);

function words(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .match(/[a-z0-9+#.-]+/g) || [];
}

function meaningfulWords(text) {
  return [
    ...new Set(
      words(text).filter(
        (word) =>
          word.length > 2 &&
          !STOP_WORDS.has(word)
      )
    ),
  ];
}

function calculateRelevance(post, niche, query) {
  const title = String(post.title || "").toLowerCase();

  const body = String(post.postText || "").toLowerCase();

  const combined = `${title} ${body}`;

  const nicheTokens = meaningfulWords(niche);

  const queryTokens = meaningfulWords(query);

  let score = 0;

  // Matching the requested query is the strongest signal.
  if (query && combined.includes(query.toLowerCase())) {
    score += 35;
  }

  // Match niche terms.
  for (const token of nicheTokens) {
    if (title.includes(token)) {
      score += 10;
    } else if (body.includes(token)) {
      score += 5;
    }
  }

  // Match query terms.
  for (const token of queryTokens) {
    if (title.includes(token)) {
      score += 8;
    } else if (body.includes(token)) {
      score += 4;
    }
  }

  // Generic signals that a post discusses a real problem.
  const problemSignals = [
    "problem",
    "struggle",
    "challenging",
    "challenge",
    "difficult",
    "difficulty",
    "pain point",
    "frustrated",
    "recommendation",
    "recommend",
    "alternative",
    "looking for",
    "need help",
    "how do i",
    "how can i",
    "any advice",
    "any suggestions",
    "not working",
    "failed",
    "issue",
    "solution",
    "automate",
    "improve",
  ];

  for (const signal of problemSignals) {
    if (combined.includes(signal)) {
      score += 4;
    }
  }

  return Math.max(0, Math.min(100, score));
}

// ============================================================
// COUNT SAVED RESULTS FOR A TASK
//
// This helps recover from a case where the post insert worked
// but the planner_runs counter update failed.
// ============================================================

async function getSavedResults(env, plannerId) {
  const params = new URLSearchParams({
    select: "id,reddit_post_id",

    planner_id: `eq.${plannerId}`,

    limit: "100",
  });

  const response = await supabaseRequest(
    env,
    `/rest/v1/reddit_research_results?${params.toString()}`
  );

  if (!Array.isArray(response.data)) {
    throw new Error(
      "Unexpected reddit_research_results response"
    );
  }

  return response.data;
}

// ============================================================
// RECONCILE TASK PROGRESS
//
// The results table is used to calculate the true progress.
// 5 results => pending_count = 0, status = Completed.
// ============================================================

async function reconcileTaskProgress(env, task) {
  const savedResults = await getSavedResults(
    env,
    task.id
  );

  const savedCount = Math.min(
    TOTAL_POSTS_PER_TASK,
    savedResults.length
  );

  const pendingCount = Math.max(
    0,
    TOTAL_POSTS_PER_TASK - savedCount
  );

  const nextStatus =
    pendingCount === 0
      ? "Completed"
      : "pending";

  const params = new URLSearchParams({
    id: `eq.${task.id}`,
    select: "*",
  });

  const response = await supabaseRequest(
    env,
    `/rest/v1/planner_runs?${params.toString()}`,
    {
      method: "PATCH",

      headers: {
        "Prefer": "return=representation",
      },

      body: {
        pending_count: pendingCount,
        status: nextStatus,
        error: null,
      },
    }
  );

  if (
    !Array.isArray(response.data) ||
    response.data.length === 0
  ) {
    throw new Error(
      "Could not update planner task progress"
    );
  }

  return {
    savedCount,
    pendingCount,
    status: nextStatus,
  };
}

// ============================================================
// SAVE ONE POST
//
// The unique constraint (planner_id, reddit_post_id)
// prevents the same post being saved twice for one task.
// ============================================================

async function savePost(
  env,
  task,
  post,
  query,
  relevanceScore
) {
  const params = new URLSearchParams({
    on_conflict: "planner_id,reddit_post_id",
    select: "id,reddit_post_id,planner_id",
  });

  const response = await supabaseRequest(
    env,
    `/rest/v1/reddit_research_results?${params.toString()}`,
    {
      method: "POST",

      headers: {
        "Prefer":
          "resolution=ignore-duplicates,return=representation",
      },

      body: {
        user_id: task.user_id,

        application_id: task.application_id,

        planner_id: task.id,

        reddit_post_id: post.id,

        subreddit: post.subreddit,

        title: post.title,

        post_text: post.postText,

        post_url: post.postUrl,

        author_username: post.author || null,

        created_utc: post.createdUtc,

        score: post.score,

        num_comments: post.numComments,

        customer_niche: task.niche || null,

        matched_query: query,

        relevance_score: relevanceScore,
      },
    }
  );

  const insertedRows = response.data;

  // With ignore-duplicates, a duplicate insert returns an
  // empty representation rather than creating a second row.
  return (
    Array.isArray(insertedRows) &&
    insertedRows.length > 0
  );
}

// ============================================================
// RESET A TASK AFTER AN ERROR
// ============================================================

async function resetTaskAfterError(env, task, error) {
  try {
    const params = new URLSearchParams({
      id: `eq.${task.id}`,
      select: "id,status",
    });

    await supabaseRequest(
      env,
      `/rest/v1/planner_runs?${params.toString()}`,
      {
        method: "PATCH",

        headers: {
          "Prefer": "return=representation",
        },

        body: {
          status: "pending",
          error: String(error).slice(0, 3000),
        },
      }
    );
  } catch (resetError) {
    console.error(
      "Could not reset task:",
      errorMessage(resetError)
    );
  }
}

// ============================================================
// PROCESS ONE TASK
//
// Mapping:
//   pending_count 5 => first subreddit + first query
//   pending_count 4 => second subreddit + second query
//   pending_count 3 => third subreddit + third query
//   pending_count 2 => fourth subreddit + fourth query
//   pending_count 1 => fifth subreddit + fifth query
//
// If no suitable post exists in the primary subreddit,
// the worker rotates through the other subreddits using
// the SAME query.
// ============================================================

async function processTask(env, task) {
  // First reconcile progress. This also repairs an interrupted
  // previous run if the result was saved but the counter was not.
  const progress = await reconcileTaskProgress(env, task);

  if (progress.pendingCount === 0) {
    return {
      success: true,
      task_id: task.id,
      status: "Completed",
      saved_count: progress.savedCount,
      message: "This task already has five saved posts.",
    };
  }

  const parsed = parseTask(task);

  if (!parsed.subreddits.length) {
    throw new Error(
      "No subreddits were found under Recommended Subreddits"
    );
  }

  if (!parsed.queries.length) {
    throw new Error(
      "No queries were found under Search Queries"
    );
  }

  const remaining = Number(progress.pendingCount);

  const index = TOTAL_POSTS_PER_TASK - remaining;

  const query = parsed.queries[index];

  if (!query) {
    throw new Error(
      `The task does not contain query number ${index + 1}`
    );
  }

  const primarySubreddit =
    parsed.subreddits[index];

  if (!primarySubreddit) {
    throw new Error(
      `The task does not contain subreddit number ${index + 1}`
    );
  }

  const connectionId = await getRedditConnection(
    env,
    task
  );

  // Rotate through subreddits, starting with the one mapped
  // to the current pending_count.
  const orderedSubreddits = [
    ...parsed.subreddits.slice(index),
    ...parsed.subreddits.slice(0, index),
  ];

  const cutoffSeconds =
    Math.floor(Date.now() / 1000) -
    MAX_POST_AGE_DAYS * 24 * 60 * 60;

  for (const subreddit of orderedSubreddits) {
    console.log(
      `Searching r/${subreddit} for "${query}"`
    );

    const searchResponse = await executeComposioTool(
      env,
      connectionId,
      REDDIT_SEARCH_TOOL,
      {
        query,
        subreddit,
        sort: "new",
        time_filter: "all",
        limit: MAX_SEARCH_RESULTS,
      }
    );

    const posts = extractPosts(searchResponse);

    // Keep only posts from the requested subreddit and
    // within the 90-day window.
    const eligiblePosts = posts
      .filter((post) => {
        return (
          post.subreddit.toLowerCase() ===
            subreddit.toLowerCase() &&
          post.createdUtc >= cutoffSeconds &&
          isWithinLast90Days(post)
        );
      })
      .map((post) => ({
        ...post,
        relevanceScore: calculateRelevance(
          post,
          parsed.niche,
          query
        ),
      }))
      .filter(
        (post) =>
          post.relevanceScore >= MIN_RELEVANCE_SCORE
      )
      .sort(
        (a, b) => b.createdUtc - a.createdUtc
      );

    for (const post of eligiblePosts) {
      let inserted;

      try {
        inserted = await savePost(
          env,
          task,
          post,
          query,
          post.relevanceScore
        );
      } catch (insertError) {
        // The request could fail after the database inserted
        // the row. Check the database before reporting failure.
        const existing = await getSavedResults(
          env,
          task.id
        );

        const alreadySaved = existing.some(
          (row) => row.reddit_post_id === post.id
        );

        if (alreadySaved) {
          const repaired = await reconcileTaskProgress(
            env,
            task
          );

          return {
            success: true,
            task_id: task.id,
            status: repaired.status,
            saved_count: repaired.savedCount,
            pending_count: repaired.pendingCount,
            recovered_after_insert_error: true,
          };
        }

        throw insertError;
      }

      if (!inserted) {
        // Duplicate: try another real post.
        continue;
      }

      // One new post was inserted. Recalculate progress
      // from saved rows instead of blindly decrementing.
      const updatedProgress = await reconcileTaskProgress(
        env,
        task
      );

      return {
        success: true,
        task_id: task.id,
        application_id: task.application_id,

        saved_post: {
          reddit_post_id: post.id,
          subreddit: post.subreddit,
          title: post.title,
          post_url: post.postUrl,
          created_utc: post.createdUtc,
          matched_query: query,
          relevance_score: post.relevanceScore,
        },

        saved_count: updatedProgress.savedCount,

        pending_count: updatedProgress.pendingCount,

        status: updatedProgress.status,
      };
    }
  }

  // No suitable new post was found in any configured subreddit.
  // Do not decrement pending_count.
  const message =
    `No suitable new Reddit post found for query "${query}" ` +
    `in the configured subreddits within the last ` +
    `${MAX_POST_AGE_DAYS} days.`;

  await supabaseRequest(
    env,
    `/rest/v1/planner_runs?id=eq.${encodeURIComponent(task.id)}`,
    {
      method: "PATCH",

      body: {
        status: "pending",
        error: message,
      },
    }
  );

  return {
    success: false,
    task_id: task.id,
    pending_count: updatedPendingCountFallback(task),
    error: message,
  };
}

function updatedPendingCountFallback(task) {
  return Number(task.pending_count || 0);
}

// ============================================================
// OPTIONAL CRON AUTHENTICATION
//
// If you set a CRON_SECRET Cloudflare secret, POST /cron must
// include header: x-cron-secret: YOUR_SECRET
//
// If you don't set CRON_SECRET, this check is disabled.
// ============================================================

function cronAuthorized(request, env) {
  if (!env.CRON_SECRET) {
    return true;
  }

  return (
    request.headers.get("x-cron-secret") ===
    env.CRON_SECRET
  );
}

// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (
      request.method === "GET" &&
      url.pathname === "/health"
    ) {
      return jsonResponse({
        success: true,
        worker: WORKER_NAME,
        status: "healthy",
        timestamp: new Date().toISOString(),
      });
    }

    // Cron entry point
    if (
      request.method === "POST" &&
      url.pathname === "/cron"
    ) {
      if (!cronAuthorized(request, env)) {
        return jsonResponse(
          {
            success: false,
            error: "Unauthorized cron request",
          },
          401
        );
      }

      let task = null;

      try {
        task = await claimLatestTask(env);

        if (!task) {
          return jsonResponse({
            success: true,
            message: "No eligible Reddit task found.",
          });
        }

        const result = await processTask(env, task);

        if (!result.success) {
          return jsonResponse(result, 200);
        }

        return jsonResponse(result, 200);
      } catch (error) {
        const message = errorMessage(error);

        console.error(
          "Reddit Worker error:",
          message
        );

        if (task) {
          await resetTaskAfterError(
            env,
            task,
            message
          );
        }

        return jsonResponse(
          {
            success: false,
            task_id: task?.id || null,
            error: message,
          },
          500
        );
      }
    }

    return jsonResponse(
      {
        success: false,
        error: "Not found",
        routes: [
          "GET /health",
          "POST /cron",
        ],
      },
      404
    );
  },
};

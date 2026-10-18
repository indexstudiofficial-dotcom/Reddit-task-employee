// ============================================================
// REDDIT TASK EMPLOYEE
// Cloudflare Worker + Supabase + Composio
// ============================================================

const WORKER_NAME = "reddit-task-employee";

const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3.1";

const REDDIT_SEARCH_TOOL = "REDDIT_SEARCH_ACROSS_SUBREDDITS";

// Task requirements
const POSTS_PER_TASK = 5;
const MAX_SEARCH_RESULTS = 100;
const MAX_POST_AGE_DAYS = 90;
const MIN_RELEVANCE_SCORE = 15;

// Claim stale processing tasks again after 15 minutes.
const STALE_TASK_MINUTES = 15;

// ============================================================
// MAIN REQUEST HANDLER
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        success: true,
        worker: WORKER_NAME,
        status: "healthy",
        timestamp: new Date().toISOString(),
      });
    }

    if (request.method !== "POST" || url.pathname !== "/cron") {
      return jsonResponse(
        {
          success: false,
          error: "Not found. Use GET /health or POST /cron.",
        },
        404
      );
    }

    // Optional cron authentication.
    if (env.CRON_SECRET) {
      const suppliedSecret = request.headers.get("x-cron-secret");

      if (suppliedSecret !== env.CRON_SECRET) {
        return jsonResponse(
          {
            success: false,
            error: "Unauthorized",
          },
          401
        );
      }
    }

    try {
      validateEnvironment(env);

      const task = await claimNextTask(env);

      if (!task) {
        return jsonResponse({
          success: true,
          worker: WORKER_NAME,
          message: "No eligible Reddit tasks found.",
          processed: false,
        });
      }

      const result = await processTask(env, task);

      return jsonResponse({
        success: true,
        worker: WORKER_NAME,
        processed: true,
        ...result,
      });
    } catch (error) {
      console.error("Worker error:", errorMessage(error));

      return jsonResponse(
        {
          success: false,
          worker: WORKER_NAME,
          error: errorMessage(error),
        },
        500
      );
    }
  },
};

// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

function validateEnvironment(env) {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "COMPOSIO_API_KEY",
  ];

  const missing = required.filter((name) => !env[name]);

  if (missing.length > 0) {
    throw new Error(
      `Missing Cloudflare Worker secrets: ${missing.join(", ")}`
    );
  }
}

// ============================================================
// JSON RESPONSE
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

// ============================================================
// GENERAL HELPERS
// ============================================================

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value);
}

function normalizeSubreddit(value) {
  return asString(value)
    .trim()
    .replace(/^https?:\/\/(?:www\.)?reddit\.com\/r\//i, "")
    .replace(/^\/?r\//i, "")
    .replace(/^\/+|\/+$/g, "");
}

function normalizeText(value) {
  return asString(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// SUPABASE REST REQUEST HELPER
// ============================================================

async function supabaseRequest(
  env,
  table,
  {
    method = "GET",
    query = "",
    body,
    prefer,
  } = {}
) {
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  const url = `${baseUrl}/rest/v1/${table}${query ? `?${query}` : ""}`;

  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: "application/json",
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (prefer) {
    headers.Prefer = prefer;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail =
      typeof data === "string" ? data : JSON.stringify(data);

    throw new Error(
      `Supabase ${method} ${table} failed (${response.status}): ${detail}`
    );
  }

  return data;
}

// ============================================================
// CLAIM NEXT TASK
// ============================================================

async function claimNextTask(env) {
  const staleBefore = new Date(
    Date.now() - STALE_TASK_MINUTES * 60 * 1000
  ).toISOString();

  const query = new URLSearchParams({
    select: "*",
    worker_type: "eq.reddit_research",
    source: "eq.reddit",
    pending_count: "gt.0",
    order: "created_at.desc",
    limit: "20",
  });

  const tasks = await supabaseRequest(env, "planner_runs", {
    query: query.toString(),
  });

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return null;
  }

  for (const task of tasks) {
    const status = asString(task.status).toLowerCase();

    const isPending =
      status === "pending" ||
      status === "" ||
      status === "queued";

    const isStaleProcessing =
      status === "processing" &&
      task.started_at &&
      new Date(task.started_at).getTime() <
        new Date(staleBefore).getTime();

    if (!isPending && !isStaleProcessing) {
      continue;
    }

    // Optimistic claim: only claim if the task still has the
    // status and pending count that we originally read.
    const claimQuery = new URLSearchParams({
      id: `eq.${task.id}`,
      pending_count: "gt.0",
    });

    if (isPending) {
      if (status === "") {
        claimQuery.set("status", "is.null");
      } else {
        claimQuery.set("status", `eq.${task.status}`);
      }
    } else {
      claimQuery.set("status", "eq.processing");
      claimQuery.set("started_at", `lt.${staleBefore}`);
    }

    const claimed = await supabaseRequest(env, "planner_runs", {
      method: "PATCH",
      query: claimQuery.toString(),
      body: {
        status: "processing",
        started_at: new Date().toISOString(),
        error: null,
      },
      prefer: "return=representation",
    });

    if (Array.isArray(claimed) && claimed.length > 0) {
      return claimed[0];
    }
  }

  return null;
}

// ============================================================
// PROCESS TASK
// ============================================================

async function processTask(env, task) {
  try {
    if (!task.user_id) {
      throw new Error("Task is missing user_id.");
    }

    if (!task.application_id) {
      throw new Error("Task is missing application_id.");
    }

    const taskDetails = parseTask(task.task);

    if (taskDetails.queries.length === 0) {
      throw new Error(
        "No search queries found in the task. Add a Search Queries section."
      );
    }

    if (taskDetails.subreddits.length === 0) {
      throw new Error(
        "No subreddits found in the task. Add a Recommended Subreddits section."
      );
    }

    // Find the user's Reddit connection for this application.
    const connection = await getRedditConnection(
      env,
      task.user_id,
      task.application_id
    );

    if (!connection) {
      throw new Error(
        "No active Reddit connection found for this user and application."
      );
    }

    // Use the number of posts already saved for this task.
    const existingPosts = await getExistingResults(env, task.id);

    const existingIds = new Set(
      existingPosts.map((post) => asString(post.reddit_post_id))
    );

    const remaining = Math.max(
      0,
      POSTS_PER_TASK - existingPosts.length
    );

    if (remaining === 0) {
      await updateTaskProgress(env, task, existingPosts.length);

      return {
        task_id: task.id,
        message: "Task already has five saved Reddit posts.",
        saved_count: existingPosts.length,
        pending_count: 0,
        status: "Completed",
      };
    }

    const queryIndex = Math.min(
      POSTS_PER_TASK - remaining,
      taskDetails.queries.length - 1
    );

    const searchQuery =
      taskDetails.queries[queryIndex] || taskDetails.queries[0];

    const primarySubredditIndex = Math.min(
      POSTS_PER_TASK - remaining,
      taskDetails.subreddits.length - 1
    );

    const primarySubreddit =
      taskDetails.subreddits[primarySubredditIndex] ||
      taskDetails.subreddits[0];

    // Search the primary subreddit first, then other subreddits
    // if we do not find a suitable new post.
    const subredditOrder = [
      primarySubreddit,
      ...taskDetails.subreddits.filter(
        (name) => name.toLowerCase() !== primarySubreddit.toLowerCase()
      ),
    ];

    const foundPosts = [];
    const seenThisRun = new Set(existingIds);

    for (const subreddit of subredditOrder) {
      if (foundPosts.length >= remaining) {
        break;
      }

      const rawResponse = await executeComposioTool(
        env,
        connection.connection_id,
        {
          // IMPORTANT: Composio requires search_query, NOT query.
          search_query: searchQuery,
          subreddit,
          sort: "new",
          time_filter: "all",
          limit: MAX_SEARCH_RESULTS,
        },
        task.user_id
      );

      const normalizedPosts = extractPosts(rawResponse);

      const eligiblePosts = normalizedPosts
        .map((post) =>
          normalizePost(post, subreddit, searchQuery, taskDetails.niche)
        )
        .filter(Boolean)
        .filter((post) => isWithinAgeLimit(post.created_utc))
        .filter((post) => !seenThisRun.has(post.reddit_post_id))
        .filter(
          (post) => post.relevance_score >= MIN_RELEVANCE_SCORE
        );

      eligiblePosts.sort(
        (a, b) => b.created_utc - a.created_utc
      );

      for (const post of eligiblePosts) {
        if (foundPosts.length >= remaining) {
          break;
        }

        if (seenThisRun.has(post.reddit_post_id)) {
          continue;
        }

        seenThisRun.add(post.reddit_post_id);
        foundPosts.push(post);
      }

      // Avoid hammering Composio when trying multiple subreddits.
      await sleep(200);
    }

    let savedCount = 0;

    if (foundPosts.length > 0) {
      savedCount = await saveResults(
        env,
        task,
        foundPosts
      );
    }

    // Re-read results after insertion to calculate the true total.
    const allResults = await getExistingResults(env, task.id);

    await updateTaskProgress(env, task, allResults.length);

    const completed = allResults.length >= POSTS_PER_TASK;

    return {
      task_id: task.id,
      niche: taskDetails.niche || task.niche || null,
      matched_query: searchQuery,
      searched_subreddit: primarySubreddit,
      found_count: foundPosts.length,
      saved_count_this_run: savedCount,
      total_saved_count: allResults.length,
      pending_count: Math.max(
        0,
        POSTS_PER_TASK - allResults.length
      ),
      status: completed ? "Completed" : "pending",
      message: completed
        ? "Task completed with five saved Reddit posts."
        : foundPosts.length === 0
          ? "No new qualifying Reddit posts found. Task remains pending."
          : "Results saved. More posts are still needed.",
    };
  } catch (error) {
    console.error(
      `Task ${task.id} failed:`,
      errorMessage(error)
    );

    // Return the task to pending so a future cron run can retry.
    // The error is retained for debugging.
    await markTaskFailed(env, task, errorMessage(error));

    return {
      success: false,
      task_id: task.id,
      error: errorMessage(error),
      status: "pending",
    };
  }
}

// ============================================================
// FIND REDDIT CONNECTION
// ============================================================

async function getRedditConnection(
  env,
  userId,
  applicationId
) {
  const query = new URLSearchParams({
    select: "id,user_id,application_id,integration_id,connection_id,status",
    user_id: `eq.${userId}`,
    application_id: `eq.${applicationId}`,
    integration_id: "eq.reddit",
    order: "updated_at.desc",
    limit: "20",
  });

  const rows = await supabaseRequest(env, "user_integrations", {
    query: query.toString(),
  });

  if (!Array.isArray(rows)) {
    return null;
  }

  return (
    rows.find((row) => {
      const status = asString(row.status).toLowerCase();

      return (
        row.connection_id &&
        (status === "connected" || status === "active")
      );
    }) || null
  );
}

// ============================================================
// COMPOSIO TOOL EXECUTION
// ============================================================

async function executeComposioTool(
  env,
  connectionId,
  argumentsObject,
  userId
) {
  if (!connectionId) {
    throw new Error("Composio connection_id is missing.");
  }

  if (!userId) {
    throw new Error("Composio entity_id/user ID is missing.");
  }

  const url = `${COMPOSIO_API_BASE}/tools/execute/${REDDIT_SEARCH_TOOL}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.COMPOSIO_API_KEY,
    },
    body: JSON.stringify({
      connected_account_id: connectionId,

      // Required by Composio for connected-account execution.
      entity_id: String(userId),

      version: "latest",
      arguments: argumentsObject,
    }),
  });

  const responseText = await response.text();

  let result;

  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch {
    result = responseText;
  }

  if (!response.ok) {
    throw new Error(
      `Composio tool ${REDDIT_SEARCH_TOOL} failed (${response.status}): ${
        typeof result === "string"
          ? result
          : JSON.stringify(result)
      }`
    );
  }

  // Some integrations can return an HTTP-success response whose
  // JSON body reports an execution error.
  if (result && typeof result === "object") {
    if (result.error) {
      throw new Error(
        `Composio tool ${REDDIT_SEARCH_TOOL} failed: ${
          typeof result.error === "string"
            ? result.error
            : JSON.stringify(result.error)
        }`
      );
    }

    if (
      result.success === false ||
      result.successful === false
    ) {
      throw new Error(
        `Composio tool ${REDDIT_SEARCH_TOOL} execution failed: ${JSON.stringify(
          result
        )}`
      );
    }
  }

  return result;
}

// ============================================================
// PARSE TASK TEXT
// ============================================================

function parseTask(rawTask) {
  if (rawTask && typeof rawTask === "object") {
    return {
      niche: asString(
        rawTask.niche || rawTask.customer_niche
      ),
      subreddits: normalizeSubreddits(
        rawTask.subreddits ||
          rawTask.recommended_subreddits ||
          []
      ),
      queries: normalizeQueries(
        rawTask.queries || rawTask.search_queries || []
      ),
    };
  }

  const text = asString(rawTask);
  const lines = text.split(/\r?\n/);

  let niche = "";
  let section = "";
  const subreddits = [];
  const queries = [];

  for (const originalLine of lines) {
    const line = originalLine.trim();

    if (!line) {
      continue;
    }

    const nicheMatch = line.match(
      /^customer\s+niche\s*:\s*(.+)$/i
    );

    if (nicheMatch) {
      niche = nicheMatch[1].trim();
      continue;
    }

    if (/^(recommended\s+subreddits|subreddits)\s*:/i.test(line)) {
      section = "subreddits";
      continue;
    }

    if (/^(search\s+queries|queries)\s*:/i.test(line)) {
      section = "queries";
      continue;
    }

    if (
      /^(objective|goal|instructions|description|task)\s*:/i.test(
        line
      )
    ) {
      section = "";
      continue;
    }

    const bulletMatch = line.match(/^(?:[-*•]|\d+[.)])\s*(.+)$/);

    const value = bulletMatch
      ? bulletMatch[1].trim()
      : line;

    if (section === "subreddits") {
      const subreddit = normalizeSubreddit(value);

      if (subreddit) {
        subreddits.push(subreddit);
      }
    } else if (section === "queries") {
      const query = value.trim();

      if (query) {
        queries.push(query);
      }
    }
  }

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
        .map(normalizeSubreddit)
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
        .map((value) => asString(value).trim())
        .filter(Boolean)
    ),
  ];
}

// ============================================================
// EXTRACT POSTS FROM COMPOSIO RESPONSE
// ============================================================

function extractPosts(response) {
  const found = [];
  const visited = new Set();

  function walk(value, depth = 0) {
    if (depth > 12 || value === null || value === undefined) {
      return;
    }

    if (typeof value !== "object") {
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

    // Common Reddit post fields.
    const hasTitle =
      typeof value.title === "string" &&
      value.title.trim().length > 0;

    const permalink =
      value.permalink ||
      value.url ||
      value.post_url ||
      value.link;

    const hasId =
      value.id ||
      value.post_id ||
      value.name;

    const hasDate =
      value.created_utc !== undefined ||
      value.created !== undefined ||
      value.createdAt !== undefined ||
      value.created_at !== undefined ||
      value.timestamp !== undefined;

    if (hasTitle && permalink && hasId && hasDate) {
      found.push(value);
    }

    // Search common wrapper properties.
    for (const [key, child] of Object.entries(value)) {
      if (
        [
          "data",
          "results",
          "posts",
          "items",
          "children",
          "submissions",
          "response",
          "output",
          "result",
          "content",
          "body",
        ].includes(key)
      ) {
        walk(child, depth + 1);
      }
    }
  }

  walk(response);

  // Deduplicate the raw objects by post ID.
  const unique = new Map();

  for (const post of found) {
    const id = asString(
      post.id || post.post_id || post.name
    ).replace(/^t3_/, "");

    if (id && !unique.has(id)) {
      unique.set(id, post);
    }
  }

  return [...unique.values()];
}

// ============================================================
// NORMALIZE A REDDIT POST
// ============================================================

function normalizePost(
  post,
  fallbackSubreddit,
  matchedQuery,
  niche
) {
  const title = asString(post.title).trim();

  if (!title) {
    return null;
  }

  const rawId = asString(
    post.id || post.post_id || post.name
  ).trim();

  const redditPostId = rawId.replace(/^t3_/, "");

  if (!redditPostId) {
    return null;
  }

  let postUrl = asString(
    post.permalink ||
      post.post_url ||
      post.url ||
      post.link
  ).trim();

  if (postUrl.startsWith("/")) {
    postUrl = `https://www.reddit.com${postUrl}`;
  }

  if (!postUrl || !/^https?:\/\//i.test(postUrl)) {
    return null;
  }

  const subreddit = normalizeSubreddit(
    post.subreddit ||
      post.subreddit_name ||
      post.subredditName ||
      fallbackSubreddit
  );

  if (!subreddit) {
    return null;
  }

  const createdUtc = normalizeTimestamp(
    post.created_utc ??
      post.created ??
      post.createdAt ??
      post.created_at ??
      post.timestamp
  );

  if (!createdUtc) {
    return null;
  }

  const postText = asString(
    post.selftext ||
      post.post_text ||
      post.text ||
      post.body ||
      post.description
  );

  const author = asString(
    post.author ||
      post.author_username ||
      post.username
  ).replace(/^u\//, "");

  const score = safeInteger(
    post.score ??
      post.ups ??
      post.upvotes ??
      0
  );

  const numComments = safeInteger(
    post.num_comments ??
      post.comments_count ??
      post.comment_count ??
      0
  );

  const relevanceScore = calculateRelevance(
    title,
    postText,
    matchedQuery,
    niche
  );

  return {
    reddit_post_id: redditPostId,
    subreddit,
    title,
    post_text: postText,
    post_url: postUrl,
    author_username: author || null,
    created_utc: createdUtc,
    score,
    num_comments: numComments,
    customer_niche: niche || null,
    matched_query: matchedQuery,
    relevance_score: relevanceScore,
  };
}

// ============================================================
// DATE AND NUMBER HELPERS
// ============================================================

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  let number = Number(value);

  if (!Number.isFinite(number)) {
    const parsed = Date.parse(String(value));

    if (!Number.isFinite(parsed)) {
      return 0;
    }

    number = Math.floor(parsed / 1000);
  }

  // Milliseconds -> seconds.
  if (number > 100000000000) {
    number = Math.floor(number / 1000);
  }

  return Math.floor(number);
}

function safeInteger(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.trunc(number);
}

function isWithinAgeLimit(createdUtc) {
  if (!createdUtc || createdUtc <= 0) {
    return false;
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - createdUtc;

  return (
    ageSeconds >= 0 &&
    ageSeconds <= MAX_POST_AGE_DAYS * 24 * 60 * 60
  );
}

// ============================================================
// BASIC RELEVANCE SCORING
// ============================================================

function calculateRelevance(
  title,
  postText,
  matchedQuery,
  niche
) {
  const titleText = normalizeText(title);
  const bodyText = normalizeText(postText);
  const combinedText = `${titleText} ${bodyText}`.trim();

  if (!combinedText) {
    return 0;
  }

  const queryWords = normalizeText(matchedQuery)
    .split(" ")
    .filter((word) => word.length >= 3);

  const uniqueQueryWords = [...new Set(queryWords)];

  let matchedQueryWords = 0;

  for (const word of uniqueQueryWords) {
    if (combinedText.includes(word)) {
      matchedQueryWords += 1;
    }
  }

  const queryScore =
    uniqueQueryWords.length > 0
      ? Math.round(
          (matchedQueryWords / uniqueQueryWords.length) * 45
        )
      : 0;

  const nicheWords = normalizeText(niche)
    .split(" ")
    .filter((word) => word.length >= 3);

  let nicheMatches = 0;

  for (const word of new Set(nicheWords)) {
    if (combinedText.includes(word)) {
      nicheMatches += 1;
    }
  }

  const nicheScore = Math.min(20, nicheMatches * 10);

  const problemTerms = [
    "problem",
    "struggle",
    "challenge",
    "difficult",
    "issue",
    "help",
    "need",
    "looking for",
    "how do i",
    "how can i",
    "recommend",
    "recommendation",
    "alternative",
    "frustrated",
    "pain",
    "expensive",
    "cost",
    "slow",
    "manual",
    "automate",
    "automation",
    "client",
    "customer",
    "revenue",
    "sales",
    "marketing",
    "growth",
    "onboarding",
    "pricing",
    "agency",
    "agencies",
  ];

  let problemMatches = 0;

  for (const term of problemTerms) {
    if (combinedText.includes(term)) {
      problemMatches += 1;
    }
  }

  const problemScore = Math.min(25, problemMatches * 5);

  const titleBonus =
    uniqueQueryWords.some((word) => titleText.includes(word))
      ? 10
      : 0;

  return Math.max(
    0,
    Math.min(100, queryScore + nicheScore + problemScore + titleBonus)
  );
}

// ============================================================
// READ EXISTING RESULTS FOR A TASK
// ============================================================

async function getExistingResults(env, plannerId) {
  const query = new URLSearchParams({
    select: "reddit_post_id,relevance_score",
    planner_id: `eq.${plannerId}`,
    limit: "100",
  });

  const results = await supabaseRequest(
    env,
    "reddit_research_results",
    {
      query: query.toString(),
    }
  );

  return Array.isArray(results) ? results : [];
}

// ============================================================
// SAVE RESULTS
// ============================================================

async function saveResults(env, task, posts) {
  if (!posts.length) {
    return 0;
  }

  const rows = posts.map((post) => ({
    user_id: task.user_id,
    application_id: task.application_id,
    planner_id: task.id,
    reddit_post_id: post.reddit_post_id,
    subreddit: post.subreddit,
    title: post.title,
    post_text: post.post_text || null,
    post_url: post.post_url,
    author_username: post.author_username,
    created_utc: post.created_utc,
    score: post.score,
    num_comments: post.num_comments,
    customer_niche: post.customer_niche,
    matched_query: post.matched_query,
    relevance_score: post.relevance_score,
  }));

  const query = new URLSearchParams({
    on_conflict: "planner_id,reddit_post_id",
  });

  const saved = await supabaseRequest(
    env,
    "reddit_research_results",
    {
      method: "POST",
      query: query.toString(),
      body: rows,
      prefer: "resolution=ignore-duplicates,return=representation",
    }
  );

  return Array.isArray(saved) ? saved.length : 0;
}

// ============================================================
// UPDATE TASK PROGRESS
// ============================================================

async function updateTaskProgress(env, task, savedCount) {
  const total = Math.min(POSTS_PER_TASK, savedCount);
  const pendingCount = Math.max(0, POSTS_PER_TASK - total);

  const status = pendingCount === 0 ? "Completed" : "pending";

  await supabaseRequest(env, "planner_runs", {
    method: "PATCH",
    query: new URLSearchParams({
      id: `eq.${task.id}`,
    }).toString(),
    body: {
      pending_count: pendingCount,
      status,
      error: null,
      started_at: null,
    },
    prefer: "return=minimal",
  });
}

// ============================================================
// HANDLE FAILED TASK
// ============================================================

async function markTaskFailed(env, task, message) {
  try {
    await supabaseRequest(env, "planner_runs", {
      method: "PATCH",
      query: new URLSearchParams({
        id: `eq.${task.id}`,
      }).toString(),
      body: {
        status: "pending",
        error: message.slice(0, 4000),
        started_at: null,
      },
      prefer: "return=minimal",
    });
  } catch (updateError) {
    console.error(
      "Could not update failed task:",
      errorMessage(updateError)
    );
  }
}

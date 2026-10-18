// ============================================================
// REDDIT TASK EMPLOYEE
// Cloudflare Worker
//
// GET  /health
// POST /cron
//
// Required secrets:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// COMPOSIO_API_KEY
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

// ============================================================
// RESPONSE HELPERS
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
// SUPABASE REST API
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  const baseUrl = env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!baseUrl || !serviceKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",

    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },

    body:
      options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
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
    throw new Error(
      `Supabase request failed (${response.status}): ` +
      `${typeof data === "string" ? data : JSON.stringify(data)}`
    );
  }

  return {
    data,
    headers: response.headers,
  };
}

// ============================================================
// COMPOSIO TOOL EXECUTION
//
// FIX: Composio requires BOTH:
// connected_account_id
// entity_id
//
// entity_id is the user identifier associated with the
// connected account.
// ============================================================

async function executeComposioTool(
  env,
  connectionId,
  toolSlug,
  argumentsObject,
  userId
) {
  if (!env.COMPOSIO_API_KEY) {
    throw new Error("Missing COMPOSIO_API_KEY secret");
  }

  if (!connectionId) {
    throw new Error("Composio connection ID is missing");
  }

  if (!userId) {
    throw new Error(
      "Composio entity_id is missing: task.user_id is empty"
    );
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

      // Required by the error returned by Composio.
      entity_id: String(userId),

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
      `Composio returned invalid JSON: ${text.slice(0, 800)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Composio tool ${toolSlug} failed ` +
      `(${response.status}): ` +
      JSON.stringify(result).slice(0, 1800)
    );
  }

  if (result.successful === false) {
    throw new Error(
      `Composio tool ${toolSlug} failed: ` +
      JSON.stringify(result.error || result).slice(0, 1800)
    );
  }

  if (result.error && !result.data) {
    throw new Error(
      `Composio tool ${toolSlug} failed: ` +
      JSON.stringify(result.error).slice(0, 1800)
    );
  }

  return result;
}

// ============================================================
// REDDIT CONNECTION LOOKUP
//
// Your database status is "connected", not just "active".
// Match the same user and application as the task.
// ============================================================

async function getRedditConnection(env, task) {
  if (!task.user_id || !task.application_id) {
    throw new Error(
      "Task is missing user_id or application_id"
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

  if (!Array.isArray(response.data)) {
    throw new Error(
      "Unexpected response from user_integrations"
    );
  }

  const connection = response.data.find((row) => {
    const integrationId = String(
      row.integration_id || ""
    ).toLowerCase();

    const status = String(
      row.status || ""
    ).toLowerCase();

    return (
      integrationId === "reddit" &&
      Boolean(row.connection_id) &&
      ["connected", "active"].includes(status)
    );
  });

  if (!connection) {
    throw new Error(
      "No connected Reddit integration found for " +
      `user_id=${task.user_id}, ` +
      `application_id=${task.application_id}. ` +
      `Rows returned=${response.data.length}`
    );
  }

  return connection.connection_id;
}

// ============================================================
// TASK PARSING
//
// Supports text tasks and JSON task objects.
// Subreddits and queries are taken from each task.
// ============================================================

function normalizeSubreddits(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values
        .map((value) => {
          let name = String(value || "").trim();

          name = name.replace(
            /^https?:\/\/(www\.)?reddit\.com\/r\//i,
            ""
          );

          name = name.replace(/^r\//i, "");
          name = name.replace(/^\/+|\/+$/g, "");
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

    if (
      /^[A-Za-z][A-Za-z0-9 _()/.-]{0,60}:\s*$/.test(line)
    ) {
      break;
    }

    const match = line.match(/^[-*•]\s*(.+)$/);

    if (match) {
      result.push(match[1].trim());
    }
  }

  return result;
}

function parseTask(task) {
  const content = task.task;

  if (
    content &&
    typeof content === "object" &&
    !Array.isArray(content)
  ) {
    return {
      niche: String(
        task.niche ||
        content.niche ||
        content.customer_niche ||
        ""
      ).trim(),

      subreddits: normalizeSubreddits(
        content.subreddits ||
        content.recommended_subreddits ||
        []
      ),

      queries: normalizeQueries(
        content.queries ||
        content.search_queries ||
        []
      ),
    };
  }

  const text = String(content || "");

  const nicheMatch = text.match(
    /^\s*Customer\s+Niche\s*:\s*(.+?)\s*$/im
  );

  return {
    niche: String(
      task.niche || nicheMatch?.[1] || ""
    ).trim(),

    subreddits: normalizeSubreddits(
      extractSectionBullets(
        text,
        "Recommended Subreddits"
      )
    ),

    queries: normalizeQueries(
      extractSectionBullets(text, "Search Queries")
    ),
  };
}

// ============================================================
// FIND AND CLAIM THE LATEST REDDIT TASK
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
  if (
    String(task.status || "").toLowerCase() !==
    "processing"
  ) {
    return false;
  }

  if (!task.started_at) {
    return true;
  }

  const timestamp = Date.parse(task.started_at);

  if (!Number.isFinite(timestamp)) {
    return true;
  }

  return (
    timestamp <
    Date.now() - 15 * 60 * 1000
  );
}

function isEligibleTask(task) {
  const status = String(
    task.status || ""
  ).toLowerCase();

  return (
    Number(task.pending_count) > 0 &&
    (
      status === "pending" ||
      isStaleProcessingTask(task)
    )
  );
}

async function claimTask(env, task) {
  const params = new URLSearchParams({
    id: `eq.${task.id}`,

    pending_count: `eq.${task.pending_count}`,

    select: "*",
  });

  const status = String(
    task.status || ""
  ).toLowerCase();

  if (status === "processing") {
    const staleBefore = new Date(
      Date.now() - 15 * 60 * 1000
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
        Prefer: "return=representation",
      },

      body: {
        status: "processing",
        started_at: new Date().toISOString(),
        error: null,
      },
    }
  );

  if (
    !Array.isArray(response.data) ||
    response.data.length === 0
  ) {
    return null;
  }

  return response.data[0];
}

async function claimLatestTask(env) {
  const tasks = await getCandidateTasks(env);

  for (const task of tasks) {
    if (!isEligibleTask(task)) {
      continue;
    }

    const claimed = await claimTask(env, task);

    if (claimed) {
      return claimed;
    }
  }

  return null;
}

// ============================================================
// EXTRACT ACTUAL REDDIT POSTS FROM COMPOSIO RESPONSE
// ============================================================

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

  const id = rawId.replace(/^t3_/, "");

  let postUrl = String(permalink).trim();

  if (postUrl.startsWith("/")) {
    postUrl = `https://www.reddit.com${postUrl}`;
  }

  const permalinkMatch = postUrl.match(
    /\/r\/([^/]+)\/comments\//i
  );

  const subreddit = String(
    object.subreddit ||
    permalinkMatch?.[1] ||
    ""
  ).replace(/^r\//i, "").trim();

  if (!subreddit) {
    return null;
  }

  return {
    id,
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
      !value ||
      typeof value !== "object" ||
      depth > 15 ||
      visited.has(value)
    ) {
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

    for (const [key, child] of Object.entries(value)) {
      if (key === "children" && Array.isArray(child)) {
        for (const entry of child) {
          walk(entry?.data || entry, depth + 1);
        }
      } else if (child && typeof child === "object") {
        walk(child, depth + 1);
      }
    }
  }

  walk(response);

  return [...found.values()];
}

// ============================================================
// RELEVANCE SCORING
//
// Uses task-specific niche and query keywords.
// No AI and no fixed niche-specific keywords.
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

function meaningfulWords(text) {
  const tokens =
    String(text || "")
      .toLowerCase()
      .match(/[a-z0-9+#.-]+/g) || [];

  return [
    ...new Set(
      tokens.filter(
        (token) =>
          token.length > 2 &&
          !STOP_WORDS.has(token)
      )
    ),
  ];
}

function calculateRelevance(post, niche, query) {
  const title = post.title.toLowerCase();
  const body = post.postText.toLowerCase();
  const combined = `${title} ${body}`;

  let score = 0;

  if (combined.includes(query.toLowerCase())) {
    score += 35;
  }

  for (const word of meaningfulWords(niche)) {
    if (title.includes(word)) {
      score += 10;
    } else if (body.includes(word)) {
      score += 5;
    }
  }

  for (const word of meaningfulWords(query)) {
    if (title.includes(word)) {
      score += 8;
    } else if (body.includes(word)) {
      score += 4;
    }
  }

  const problemSignals = [
    "problem",
    "struggle",
    "challenge",
    "difficult",
    "difficulty",
    "frustrated",
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
// RESULTS TABLE HELPERS
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

async function reconcileTaskProgress(env, task) {
  const saved = await getSavedResults(env, task.id);

  const savedCount = Math.min(
    TOTAL_POSTS_PER_TASK,
    saved.length
  );

  const pendingCount = Math.max(
    0,
    TOTAL_POSTS_PER_TASK - savedCount
  );

  const status =
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
        Prefer: "return=representation",
      },

      body: {
        pending_count: pendingCount,
        status,
        error: null,
      },
    }
  );

  if (
    !Array.isArray(response.data) ||
    response.data.length === 0
  ) {
    throw new Error(
      "Could not reconcile planner_runs progress"
    );
  }

  return {
    savedCount,
    pendingCount,
    status,
  };
}

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
        Prefer:
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

  return (
    Array.isArray(response.data) &&
    response.data.length > 0
  );
}

// ============================================================
// PROCESS ONE TASK
// ============================================================

async function processTask(env, task) {
  // Repair interrupted progress before doing new work.
  const initialProgress = await reconcileTaskProgress(
    env,
    task
  );

  if (initialProgress.pendingCount === 0) {
    return {
      success: true,
      task_id: task.id,
      saved_count: initialProgress.savedCount,
      pending_count: 0,
      status: "Completed",
      message: "Task already has five saved posts.",
    };
  }

  const parsed = parseTask(task);

  if (!parsed.subreddits.length) {
    throw new Error(
      "No subreddits found in the task"
    );
  }

  if (!parsed.queries.length) {
    throw new Error(
      "No search queries found in the task"
    );
  }

  const pendingCount = initialProgress.pendingCount;

  // 5 => index 0, 4 => index 1, ... 1 => index 4.
  const index = TOTAL_POSTS_PER_TASK - pendingCount;

  const query = parsed.queries[index];
  const primarySubreddit = parsed.subreddits[index];

  if (!query) {
    throw new Error(
      `Missing search query number ${index + 1}`
    );
  }

  if (!primarySubreddit) {
    throw new Error(
      `Missing subreddit number ${index + 1}`
    );
  }

  const connectionId = await getRedditConnection(
    env,
    task
  );

  // Start with the mapped subreddit, then rotate through
  // the others while keeping the same query.
  const orderedSubreddits = [
    ...parsed.subreddits.slice(index),
    ...parsed.subreddits.slice(0, index),
  ];

  const cutoff =
    Math.floor(Date.now() / 1000) -
    MAX_POST_AGE_DAYS * 24 * 60 * 60;

  for (const subreddit of orderedSubreddits) {
    console.log(
      `Searching r/${subreddit} with query "${query}"`
    );

    // FIX: task.user_id is passed as entity_id by the
    // executeComposioTool() function.
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
      },
      task.user_id
    );

    const candidates = extractPosts(searchResponse)
      .filter((post) => {
        return (
          post.subreddit.toLowerCase() ===
            subreddit.toLowerCase() &&
          post.createdUtc >= cutoff &&
          post.createdUtc <=
            Math.floor(Date.now() / 1000) + 300
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

    for (const post of candidates) {
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
        // A network failure may happen after the database
        // has already accepted the insert.
        const saved = await getSavedResults(
          env,
          task.id
        );

        const alreadySaved = saved.some(
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
            saved_count: repaired.savedCount,
            pending_count: repaired.pendingCount,
            status: repaired.status,
            recovered_after_insert_error: true,
          };
        }

        throw insertError;
      }

      if (!inserted) {
        // Duplicate result: try another post.
        continue;
      }

      const progress = await reconcileTaskProgress(
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

        saved_count: progress.savedCount,
        pending_count: progress.pendingCount,
        status: progress.status,
      };
    }
  }

  // No post was saved, so leave the counter unchanged.
  const message =
    `No suitable new post found for "${query}" in the ` +
    `configured subreddits within ${MAX_POST_AGE_DAYS} days.`;

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
    pending_count: pendingCount,
    error: message,
  };
}

// ============================================================
// OPTIONAL CRON AUTHENTICATION
//
// If CRON_SECRET is configured, send the same value in
// the x-cron-secret request header.
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

        return jsonResponse(
          result,
          result.success ? 200 : 200
        );
      } catch (error) {
        const message = errorMessage(error);

        console.error(
          "Reddit Worker error:",
          message
        );

        if (task) {
          try {
            await supabaseRequest(
              env,
              `/rest/v1/planner_runs?id=eq.${encodeURIComponent(task.id)}`,
              {
                method: "PATCH",

                body: {
                  status: "pending",
                  error: message.slice(0, 3000),
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

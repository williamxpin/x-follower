#!/usr/bin/env node

// ============================================================================
// Follow Builders — Central Feed Generator
// ============================================================================
// Runs on GitHub Actions (daily at 6am UTC) to fetch content and publish
// feed-x.json, feed-podcasts.json, and feed-blogs.json.
//
// Deduplication: tracks previously seen tweet IDs, video IDs, and article
// URLs in state-feed.json so content is never repeated across runs.
//
// Usage: node generate-feed.js [--tweets-only | --podcasts-only | --blogs-only]
// Env vars needed: X_BEARER_TOKEN, SUPADATA_API_KEY
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------

const SUPADATA_BASE = 'https://api.supadata.ai/v1';
const X_API_BASE = 'https://api.x.com/2';
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 336; // 14 days — podcasts publish weekly/biweekly, not daily
const BLOG_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 3;
const MAX_ARTICLES_PER_BLOG = 3;

// State file lives in the repo root so it gets committed by GitHub Actions
const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- State Management --------------------------------------------------------

// Tracks which tweet IDs and video IDs we've already included in feeds
// so we never send the same content twice across runs.

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { seenTweets: {}, seenVideos: {}, seenArticles: {}, lastUserUpdate: {}, roundState: null };
  }
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    // Ensure seenArticles exists for older state files
    if (!state.seenArticles) state.seenArticles = {};
    // Ensure lastUserUpdate exists for older state files
    if (!state.lastUserUpdate) state.lastUserUpdate = {};
    // Ensure roundState exists for older state files
    if (!state.roundState) state.roundState = null;
    return state;
  } catch {
    return { seenTweets: {}, seenVideos: {}, seenArticles: {}, lastUserUpdate: {}, roundState: null };
  }
}

async function saveState(state) {
  // Prune entries older than 7 days to prevent the file from growing forever
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < cutoff) delete state.seenTweets[id];
  }
  for (const [id, ts] of Object.entries(state.seenVideos)) {
    if (ts < cutoff) delete state.seenVideos[id];
  }
  for (const [id, ts] of Object.entries(state.seenArticles || {})) {
    if (ts < cutoff) delete state.seenArticles[id];
  }
  // roundState is not pruned - it tracks cross-day processing
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

const DATA_RETENTION_HOURS = 36;  // 推文数据保留时长，超过此时间的用户将被清理

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  const data = JSON.parse(await readFile(sourcesPath, 'utf-8'));
  return {
    x_accounts: data.x_accounts || [],
    categories: data.categories || {},
    podcasts: data.podcasts || [],
    blogs: data.blogs || []
  };
}

// -- YouTube Fetching (Supadata API) -----------------------------------------

async function fetchYouTubeContent(podcasts, apiKey, state, errors) {
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const allCandidates = [];

  for (const podcast of podcasts) {
    try {
      let videosUrl;
      if (podcast.type === 'youtube_playlist') {
        videosUrl = `${SUPADATA_BASE}/youtube/playlist/videos?id=${podcast.playlistId}`;
      } else {
        videosUrl = `${SUPADATA_BASE}/youtube/channel/videos?id=${podcast.channelHandle}&type=video`;
      }

      const videosRes = await fetch(videosUrl, {
        headers: { 'x-api-key': apiKey }
      });

      if (!videosRes.ok) {
        errors.push(`YouTube: Failed to fetch videos for ${podcast.name}: HTTP ${videosRes.status}`);
        continue;
      }

      const videosData = await videosRes.json();
      // Supadata returns videos split into regular, shorts, and live categories.
      // Podcasts often stream live first, so we must include liveIds too.
      // We skip shortIds since podcast episodes aren't Shorts.
      const regularIds = videosData.videoIds || videosData.video_ids || [];
      const liveIds = videosData.liveIds || videosData.live_ids || [];
      const videoIds = [...regularIds, ...liveIds];

      console.error(`  ${podcast.name}: found ${regularIds.length} regular + ${liveIds.length} live video IDs`);

      // Check first 2 videos per channel, skip already-seen ones
      for (const videoId of videoIds.slice(0, 2)) {
        if (state.seenVideos[videoId]) {
          console.error(`    Skipping ${videoId} (already seen)`);
          continue;
        }

        try {
          const metaRes = await fetch(
            `${SUPADATA_BASE}/youtube/video?id=${videoId}`,
            { headers: { 'x-api-key': apiKey } }
          );
          if (!metaRes.ok) {
            console.error(`    Metadata fetch failed for ${videoId}: HTTP ${metaRes.status}`);
            errors.push(`YouTube: Metadata fetch failed for ${videoId}: HTTP ${metaRes.status}`);
            continue;
          }
          const meta = await metaRes.json();
          const publishedAt = meta.uploadDate || meta.publishedAt || meta.date || null;

          console.error(`    Candidate: ${videoId} "${meta.title || 'Untitled'}" published=${publishedAt || 'unknown'}`);
          allCandidates.push({
            podcast, videoId,
            title: meta.title || 'Untitled',
            publishedAt
          });
          await new Promise(r => setTimeout(r, 300));
        } catch (err) {
          errors.push(`YouTube: Error fetching metadata for ${videoId}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`YouTube: Error processing ${podcast.name}: ${err.message}`);
    }
  }

  console.error(`  Total candidates: ${allCandidates.length}, cutoff: ${cutoff.toISOString()}`);

  // Pick 1 unseen video from the last 72 hours.
  // Sort OLDEST first so videos are featured in chronological order —
  // if 3 videos were published in 72h, day 1 gets the oldest, day 2 the
  // next, day 3 the newest. Dedup ensures each is featured exactly once.
  //
  // If publishedAt is missing (API didn't return a date), we still include
  // the video — it appeared near the top of the channel/playlist listing,
  // so it's likely recent. Videos without dates sort to the end.
  const withinWindow = allCandidates
    .filter(v => !v.publishedAt || new Date(v.publishedAt) >= cutoff)
    .sort((a, b) => {
      // Videos with dates first (oldest among them), then dateless ones
      if (a.publishedAt && b.publishedAt) return new Date(a.publishedAt) - new Date(b.publishedAt);
      if (a.publishedAt) return -1;
      if (b.publishedAt) return 1;
      return 0;
    });

  console.error(`  Within window: ${withinWindow.length} video(s)`);
  for (const v of withinWindow) {
    console.error(`    - ${v.videoId} "${v.title}" published=${v.publishedAt || 'unknown'}`);
  }

  const selected = withinWindow[0]; // oldest unseen video
  if (!selected) return [];

  // Fetch transcript
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${selected.videoId}`;
    const transcriptRes = await fetch(
      `${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
      { headers: { 'x-api-key': apiKey } }
    );

    if (!transcriptRes.ok) {
      errors.push(`YouTube: Failed to get transcript for ${selected.videoId}: HTTP ${transcriptRes.status}`);
      return [];
    }

    const transcriptData = await transcriptRes.json();

    // Mark as seen
    state.seenVideos[selected.videoId] = Date.now();

    return [{
      source: 'podcast',
      name: selected.podcast.name,
      title: selected.title,
      videoId: selected.videoId,
      url: `https://youtube.com/watch?v=${selected.videoId}`,
      publishedAt: selected.publishedAt,
      transcript: transcriptData.content || ''
    }];
  } catch (err) {
    errors.push(`YouTube: Error fetching transcript for ${selected.videoId}: ${err.message}`);
    return [];
  }
}

// -- X/Twitter Fetching (Official API v2) ------------------------------------

async function fetchXContent(xAccounts, bearerToken, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Batch lookup all user IDs (1 API call)
  const handles = xAccounts.map(a => a.handle);
  let userMap = {};

  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const res = await fetch(
        `${X_API_BASE}/users/by?usernames=${batch.join(',')}&user.fields=name,description`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        errors.push(`X API: User lookup failed: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      for (const user of (data.data || [])) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          name: user.name,
          description: user.description || ''
        };
      }
      if (data.errors) {
        for (const err of data.errors) {
          errors.push(`X API: User not found: ${err.value || err.detail}`);
        }
      }
    } catch (err) {
      errors.push(`X API: User lookup error: ${err.message}`);
    }
  }

  // Fetch recent tweets per user with round-based processing
  const today = new Date().toISOString().split('T')[0];
  const TARGET_COUNT = xAccounts.length;  // Dynamic: current 54, future may change
  const BATCH_SIZE = 5;
  const USER_DELAY = 180000;  // 180 seconds between users
  const BATCH_DELAY = 180000; // 180 seconds between batches
  
  // Initialize or reset roundState based on date
  if (!state.roundState || state.roundState.lastRunDate !== today) {
    // New day - reset round state
    state.roundState = {
      remainingUsers: [],
      processedToday: 0,
      lastRunDate: today,
      targetCount: TARGET_COUNT
    };
    console.error(`New day started. Target: ${TARGET_COUNT} users`);
  } else {
    // Continue from previous run today
    console.error(`Continuing run. Already processed: ${state.roundState.processedToday}/${TARGET_COUNT}`);
  }
  
  // Build processing queue: remaining from last round + new users
  const processingQueue = [];
  const processedHandles = new Set();
  
  // 1. First, add remaining users from previous round (if any)
  for (const handle of (state.roundState.remainingUsers || [])) {
    const account = xAccounts.find(a => a.handle.toLowerCase() === handle.toLowerCase());
    if (account && !processedHandles.has(handle.toLowerCase())) {
      processingQueue.push({ ...account, isCarryOver: true });
      processedHandles.add(handle.toLowerCase());
    }
  }
  
  // 2. Then add new users from current list until we reach target
  for (const account of xAccounts) {
    if (processingQueue.length >= TARGET_COUNT) break;
    if (!processedHandles.has(account.handle.toLowerCase())) {
      processingQueue.push({ ...account, isCarryOver: false });
      processedHandles.add(account.handle.toLowerCase());
    }
  }
  
  const carryOverCount = processingQueue.filter(u => u.isCarryOver).length;
  const newCount = processingQueue.filter(u => !u.isCarryOver).length;
  console.error(`Processing queue: ${carryOverCount} carry-over + ${newCount} new = ${processingQueue.length} total`);
  
  // Process the queue in batches
  let batchIndex = 0;
  while (batchIndex < processingQueue.length) {
    const batch = processingQueue.slice(batchIndex, batchIndex + BATCH_SIZE);
    const overallProgress = state.roundState.processedToday + batchIndex;
    
    console.error(`\n[Batch ${Math.floor(batchIndex/BATCH_SIZE) + 1}/${Math.ceil(processingQueue.length/BATCH_SIZE)}] Processing ${batch.length} users (${overallProgress}/${TARGET_COUNT})`);
    
    // Process each user in the batch
    for (let i = 0; i < batch.length; i++) {
      const account = batch[i];
      const userData = userMap[account.handle.toLowerCase()];
      const userIndex = overallProgress + i + 1;
      
      if (!userData) {
        console.error(`  ✗ [${userIndex}/${TARGET_COUNT}] User not found: @${account.handle}`);
        state.roundState.processedToday++;
        await saveState(state);
        continue;
      }
      
      try {
        const userType = account.isCarryOver ? 'carry' : 'new';
        console.error(`  [${userIndex}/${TARGET_COUNT}] (${userType}) Fetching @${account.handle}...`);
        
        const res = await fetch(
          `${X_API_BASE}/users/${userData.id}/tweets?` +
          `max_results=5` +
          `&tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet` +
          `&exclude=retweets,replies` +
          `&start_time=${cutoff.toISOString()}`,
          { headers: { 'Authorization': `Bearer ${bearerToken}` } }
        );
        
        if (!res.ok) {
          errors.push(`X API: Failed to fetch tweets for @${account.handle}: HTTP ${res.status}`);
          state.lastUserUpdate[account.handle] = new Date().toISOString();
          state.roundState.processedToday++;
          await saveState(state);
          console.error(`    ✗ Failed @${account.handle}`);
          continue;
        }
        
        const data = await res.json();
        const allTweets = data.data || [];
        
        // Filter out already-seen tweets, cap at 3
        const newTweets = [];
        for (const t of allTweets) {
          if (state.seenTweets[t.id]) continue;
          if (newTweets.length >= MAX_TWEETS_PER_USER) break;
          
          newTweets.push({
            id: t.id,
            text: t.note_tweet?.text || t.text,
            createdAt: t.created_at,
            url: `https://x.com/${account.handle}/status/${t.id}`,
            likes: t.public_metrics?.like_count || 0,
            retweets: t.public_metrics?.retweet_count || 0,
            replies: t.public_metrics?.reply_count || 0,
            isQuote: t.referenced_tweets?.some(r => r.type === 'quoted') || false,
            quotedTweetId: t.referenced_tweets?.find(r => r.type === 'quoted')?.id || null
          });
          
          state.seenTweets[t.id] = Date.now();
        }
        
        if (newTweets.length > 0) {
          results.push({
            source: 'x',
            name: account.name,
            handle: account.handle,
            category: account.category || 'Other',
            bio: userData.description,
            isCarryOver: account.isCarryOver,
            tweets: newTweets
          });
        }
        
        state.lastUserUpdate[account.handle] = new Date().toISOString();
        state.roundState.processedToday++;
        await saveState(state);
        
        console.error(`    ✓ Updated @${account.handle} (${newTweets.length} new tweets)`);
        
        // Wait between users (except last in batch)
        if (i < batch.length - 1) {
          console.error(`    Waiting ${USER_DELAY/1000}s before next user...`);
          await new Promise(r => setTimeout(r, USER_DELAY));
        }
      } catch (err) {
        errors.push(`X API: Error fetching @${account.handle}: ${err.message}`);
        state.lastUserUpdate[account.handle] = new Date().toISOString();
        state.roundState.processedToday++;
        await saveState(state);
        console.error(`    ✗ Error @${account.handle}`);
      }
    }
    
    batchIndex += BATCH_SIZE;
    
    // Wait between batches (except last batch)
    if (batchIndex < processingQueue.length) {
      const remaining = TARGET_COUNT - state.roundState.processedToday;
      console.error(`\nBatch complete. ${remaining} users remaining.`);
      console.error(`Waiting ${BATCH_DELAY/1000}s before next batch...`);
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }
  
  // Calculate remaining users for next run
  const processedHandlesToday = new Set();
  for (const account of xAccounts) {
    const lastUpdate = state.lastUserUpdate?.[account.handle];
    const lastUpdateDate = lastUpdate ? lastUpdate.split('T')[0] : null;
    if (lastUpdateDate === today) {
      processedHandlesToday.add(account.handle.toLowerCase());
    }
  }
  
  const remainingUsers = xAccounts
    .filter(a => !processedHandlesToday.has(a.handle.toLowerCase()))
    .map(a => a.handle);
  
  state.roundState.remainingUsers = remainingUsers;
  
  const isComplete = state.roundState.processedToday >= TARGET_COUNT;
  console.error(`\n${isComplete ? '✓' : '⚠'} Round ${isComplete ? 'complete' : 'incomplete'}: ${state.roundState.processedToday}/${TARGET_COUNT} processed`);
  if (remainingUsers.length > 0) {
    console.error(`  ${remainingUsers.length} users remaining for next run: ${remainingUsers.join(', ')}`);
  }
  
  await saveState(state);
  return results;
}

// -- Blog Fetching (HTML scraping) -------------------------------------------

// Scrapes the Anthropic Engineering blog index page.
// The page is a Next.js app that embeds article data as JSON in <script> tags.
// We parse that JSON to extract article metadata (title, slug, date, summary).
// Falls back to regex-based HTML parsing if the JSON approach fails.
function parseAnthropicEngineeringIndex(html) {
  const articles = [];

  // Strategy 1: Look for article data in Next.js __NEXT_DATA__ script tag
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      // Navigate the Next.js page props to find article entries
      const pageProps = data?.props?.pageProps;
      const posts = pageProps?.posts || pageProps?.articles || pageProps?.entries || [];
      for (const post of posts) {
        const slug = post.slug?.current || post.slug || '';
        articles.push({
          title: post.title || 'Untitled',
          url: `https://www.anthropic.com/engineering/${slug}`,
          publishedAt: post.publishedOn || post.publishedAt || post.date || null,
          description: post.summary || post.description || ''
        });
      }
      if (articles.length > 0) return articles;
    } catch {
      // JSON parsing failed, fall through to regex approach
    }
  }

  // Strategy 2: Regex-based extraction from the rendered HTML.
  // Anthropic engineering articles follow the pattern /engineering/<slug>
  const linkRegex = /href="\/engineering\/([a-z0-9-]+)"/gi;
  const seenSlugs = new Set();
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const slug = linkMatch[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    articles.push({
      title: '', // Will be filled when we fetch the article page
      url: `https://www.anthropic.com/engineering/${slug}`,
      publishedAt: null,
      description: ''
    });
  }
  return articles;
}

// Scrapes the Claude Blog index page (claude.com/blog).
// This is a Webflow site. We extract article links, titles, and dates
// from the HTML structure.
function parseClaudeBlogIndex(html) {
  const articles = [];
  const seenSlugs = new Set();

  // Match blog post links — they follow the pattern /blog/<slug>
  // We capture surrounding context to extract titles and dates
  const linkRegex = /href="\/blog\/([a-z0-9-]+)"/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const slug = linkMatch[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    articles.push({
      title: '', // Will be filled when we fetch the article page
      url: `https://claude.com/blog/${slug}`,
      publishedAt: null,
      description: ''
    });
  }
  return articles;
}

// Extracts the main text content from an Anthropic Engineering article page.
// Tries the embedded JSON first (Next.js SSR data), then falls back to
// stripping HTML tags from the article body.
function extractAnthropicArticleContent(html) {
  let title = '';
  let author = '';
  let publishedAt = null;
  let content = '';

  // Try to get structured data from Next.js __NEXT_DATA__
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const pageProps = data?.props?.pageProps;
      const post = pageProps?.post || pageProps?.article || pageProps?.entry || pageProps;
      title = post?.title || '';
      author = post?.author?.name || post?.authors?.[0]?.name || '';
      publishedAt = post?.publishedOn || post?.publishedAt || post?.date || null;

      // Extract text from the body blocks (Sanity CMS portable text format)
      const body = post?.body || post?.content || [];
      if (Array.isArray(body)) {
        const textParts = [];
        for (const block of body) {
          if (block._type === 'block' && block.children) {
            const text = block.children.map(c => c.text || '').join('');
            if (text.trim()) textParts.push(text.trim());
          }
        }
        content = textParts.join('\n\n');
      }
      if (content) return { title, author, publishedAt, content };
    } catch {
      // Fall through to HTML stripping
    }
  }

  // Fallback: extract title from <h1> and body from <article> or main content
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();

  // Try to find the article body and strip HTML tags
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const bodyHtml = articleMatch ? articleMatch[1] : html;

  // Strip script/style tags first, then all remaining HTML tags
  content = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, author, publishedAt, content };
}

// Extracts the main text content from a Claude Blog article page.
// Uses JSON-LD schema data if present, then falls back to the rich text body.
function extractClaudeBlogArticleContent(html) {
  let title = '';
  let author = '';
  let publishedAt = null;
  let content = '';

  // Try JSON-LD structured data first (most reliable for metadata)
  const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld['@type'] === 'BlogPosting' || ld['@type'] === 'Article') {
        title = ld.headline || ld.name || '';
        author = ld.author?.name || '';
        publishedAt = ld.datePublished || null;
        break;
      }
    } catch {
      // Not valid JSON-LD, skip
    }
  }

  // Extract body text from the Webflow rich text container
  const richTextMatch = html.match(/<div[^>]*class="[^"]*u-rich-text-blog[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*w-richtext[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (richTextMatch) {
    content = richTextMatch[1]
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // If rich text extraction failed, try a broader approach
  if (!content) {
    // Get title from <h1> if not already found
    if (!title) {
      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();
    }

    // Strip the whole page down to text as a last resort
    content = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return { title, author, publishedAt, content };
}

// Main blog fetching orchestrator.
// For each blog source in the config, discovers new articles, deduplicates
// against previously seen URLs, fetches full article content, and returns
// the results for feed-blogs.json.
async function fetchBlogContent(blogs, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - BLOG_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const blog of blogs) {
    console.error(`  Processing blog: ${blog.name}...`);
    let candidates = [];

    try {
      // Step 1: Discover articles from the blog index page
      const indexRes = await fetch(blog.indexUrl, {
        headers: { 'User-Agent': 'FollowBuilders/1.0 (feed aggregator)' }
      });
      if (!indexRes.ok) {
        errors.push(`Blog: Failed to fetch index for ${blog.name}: HTTP ${indexRes.status}`);
        continue;
      }
      const indexHtml = await indexRes.text();

      // Use the right parser based on which blog this is
      if (blog.indexUrl.includes('anthropic.com')) {
        candidates = parseAnthropicEngineeringIndex(indexHtml);
      } else if (blog.indexUrl.includes('claude.com')) {
        candidates = parseClaudeBlogIndex(indexHtml);
      }

      // Step 2: Filter to unseen articles, cap at MAX_ARTICLES_PER_BLOG.
      // Blog index pages list articles newest-first. We only consider the
      // first few entries (MAX_INDEX_SCAN) to avoid crawling the entire
      // backlog on first run. Articles with a known date must fall within
      // the lookback window; articles without dates are accepted if they
      // appear near the top of the listing (likely recent).
      const MAX_INDEX_SCAN = MAX_ARTICLES_PER_BLOG; // only look at the N most recent entries
      const newArticles = [];
      for (const article of candidates.slice(0, MAX_INDEX_SCAN)) {
        if (state.seenArticles[article.url]) continue; // already seen
        // If we have a date, check it's within the lookback window
        if (article.publishedAt && new Date(article.publishedAt) < cutoff) continue;
        newArticles.push(article);
        if (newArticles.length >= MAX_ARTICLES_PER_BLOG) break;
      }

      if (newArticles.length === 0) {
        console.error(`    No new articles found`);
        continue;
      }

      console.error(`    Found ${newArticles.length} new article(s), fetching content...`);

      // Step 3: Fetch full article content for each new article
      for (const article of newArticles) {
        try {
          // Fetch the full article page
          const articleRes = await fetch(article.url, {
            headers: { 'User-Agent': 'FollowBuilders/1.0 (feed aggregator)' }
          });
          if (!articleRes.ok) {
            errors.push(`Blog: Failed to fetch article ${article.url}: HTTP ${articleRes.status}`);
            continue;
          }
          const articleHtml = await articleRes.text();

          // Use the right content extractor based on the blog
          let extracted;
          if (article.url.includes('anthropic.com/engineering')) {
            extracted = extractAnthropicArticleContent(articleHtml);
          } else if (article.url.includes('claude.com/blog')) {
            extracted = extractClaudeBlogArticleContent(articleHtml);
          }

          if (!extracted || !extracted.content) {
            errors.push(`Blog: No content extracted from ${article.url}`);
            continue;
          }

          // Merge extracted data with what we already have from the index
          results.push({
            source: 'blog',
            name: blog.name,
            title: extracted.title || article.title || 'Untitled',
            url: article.url,
            publishedAt: extracted.publishedAt || article.publishedAt || null,
            author: extracted.author || '',
            description: article.description || '',
            content: extracted.content
          });

          // Mark as seen
          state.seenArticles[article.url] = Date.now();

          // Small delay between article fetches to be polite
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          errors.push(`Blog: Error fetching article ${article.url}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`Blog: Error processing ${blog.name}: ${err.message}`);
    }
  }

  return results;
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const tweetsOnly = args.includes('--tweets-only');
  const podcastsOnly = args.includes('--podcasts-only');
  const blogsOnly = args.includes('--blogs-only');

  // If a specific --*-only flag is set, only that feed type runs.
  // If no flag is set, all three run.
  const runTweets = tweetsOnly || (!podcastsOnly && !blogsOnly);
  const runPodcasts = podcastsOnly || (!tweetsOnly && !blogsOnly);
  const runBlogs = blogsOnly || (!tweetsOnly && !podcastsOnly);

  const xBearerToken = process.env.X_BEARER_TOKEN;
  const supadataKey = process.env.SUPADATA_API_KEY;

  if (runPodcasts && !supadataKey) {
    console.error('SUPADATA_API_KEY not set');
    process.exit(1);
  }
  if (runTweets && !xBearerToken) {
    console.error('X_BEARER_TOKEN not set');
    process.exit(1);
  }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  // Fetch tweets
  if (runTweets) {
    console.error('Fetching X/Twitter content...');
    const xContent = await fetchXContent(sources.x_accounts, xBearerToken, state, errors);
    console.error(`  Found ${xContent.length} builders with new tweets in this batch`);

    // Merge with existing feed by category (accumulative mode)
    const categoryBuilders = {};
    
    // Initialize categories from config
    for (const [catId, catConfig] of Object.entries(sources.categories || {})) {
      categoryBuilders[catId] = new Map();
    }
    
    // Try to load existing feed and populate category maps
    try {
      const existingData = await readFile(join(SCRIPT_DIR, '..', 'feed-x.json'), 'utf-8');
      const existingFeed = JSON.parse(existingData);
      
      // Handle old format (flat x array) and new format (categories object)
      if (existingFeed.x && Array.isArray(existingFeed.x)) {
        // Old format: migrate to new structure
        for (const user of existingFeed.x) {
          const cat = user.category || 'Other';
          if (!categoryBuilders[cat]) categoryBuilders[cat] = new Map();
          categoryBuilders[cat].set(user.handle, user);
        }
      } else if (existingFeed.categories) {
        // New format: populate from categories
        for (const [catId, catData] of Object.entries(existingFeed.categories)) {
          if (!categoryBuilders[catId]) categoryBuilders[catId] = new Map();
          for (const user of (catData.builders || [])) {
            categoryBuilders[catId].set(user.handle, user);
          }
        }
      }
    } catch {
      // File doesn't exist, use initialized empty maps
    }

    // Merge new content into category maps
    for (const newUser of xContent) {
      const cat = newUser.category || 'Other';
      if (!categoryBuilders[cat]) categoryBuilders[cat] = new Map();
      categoryBuilders[cat].set(newUser.handle, newUser);
    }

    // Apply 36-hour retention filter and build final categories object
    const retentionCutoff = Date.now() - DATA_RETENTION_HOURS * 60 * 60 * 1000;
    const finalCategories = {};
    let totalBuilders = 0;
    let totalTweets = 0;
    const categoryStats = {};

    for (const [catId, builderMap] of Object.entries(categoryBuilders)) {
      // Filter builders by latest tweet time
      const filteredBuilders = Array.from(builderMap.values()).filter(user => {
        if (!user.tweets || user.tweets.length === 0) return false;
        const latestTweetTime = new Date(user.tweets[0].createdAt).getTime();
        return latestTweetTime >= retentionCutoff;
      });

      const removedCount = builderMap.size - filteredBuilders.length;
      if (removedCount > 0) {
        console.error(`  [${catId}] Cleaned ${removedCount} users with tweets older than ${DATA_RETENTION_HOURS}h`);
      }

      const catTweetCount = filteredBuilders.reduce((sum, u) => sum + u.tweets.length, 0);
      
      finalCategories[catId] = {
        builders: filteredBuilders,
        stats: {
          builderCount: filteredBuilders.length,
          tweetCount: catTweetCount
        }
      };

      totalBuilders += filteredBuilders.length;
      totalTweets += catTweetCount;
      categoryStats[catId] = {
        builderCount: filteredBuilders.length,
        tweetCount: catTweetCount
      };
    }

    // Remove empty categories
    for (const catId of Object.keys(finalCategories)) {
      if (finalCategories[catId].stats.builderCount === 0) {
        delete finalCategories[catId];
      }
    }

    const xFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: TWEET_LOOKBACK_HOURS,
      categories: finalCategories,
      totalStats: {
        totalBuilders,
        totalTweets,
        byCategory: categoryStats
      },
      errors: errors.filter(e => e.startsWith('X API')).length > 0
        ? errors.filter(e => e.startsWith('X API')) : undefined
    };
    
    await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(xFeed, null, 2));
    console.error(`  feed-x.json: ${totalBuilders} builders total, ${totalTweets} tweets`);
    for (const [catId, stats] of Object.entries(categoryStats)) {
      if (stats.builderCount > 0) {
        console.error(`    - ${catId}: ${stats.builderCount} builders, ${stats.tweetCount} tweets`);
      }
    }
  }

  // Fetch podcasts
  if (runPodcasts) {
    console.error('Fetching YouTube content...');
    const podcasts = await fetchYouTubeContent(sources.podcasts, supadataKey, state, errors);
    console.error(`  Found ${podcasts.length} new episodes`);

    const podcastFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: PODCAST_LOOKBACK_HOURS,
      podcasts,
      stats: { podcastEpisodes: podcasts.length },
      errors: errors.filter(e => e.startsWith('YouTube')).length > 0
        ? errors.filter(e => e.startsWith('YouTube')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify(podcastFeed, null, 2));
    console.error(`  feed-podcasts.json: ${podcasts.length} episodes`);
  }

  // Fetch blog posts
  if (runBlogs && sources.blogs && sources.blogs.length > 0) {
    console.error('Fetching blog content...');
    const blogContent = await fetchBlogContent(sources.blogs, state, errors);
    console.error(`  Found ${blogContent.length} new blog post(s)`);

    const blogFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: BLOG_LOOKBACK_HOURS,
      blogs: blogContent,
      stats: { blogPosts: blogContent.length },
      errors: errors.filter(e => e.startsWith('Blog')).length > 0
        ? errors.filter(e => e.startsWith('Blog')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-blogs.json'), JSON.stringify(blogFeed, null, 2));
    console.error(`  feed-blogs.json: ${blogContent.length} posts`);
  }

  // Save dedup state
  await saveState(state);

  if (errors.length > 0) {
    console.error(`  ${errors.length} non-fatal errors`);
  }
}

main().catch(err => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});

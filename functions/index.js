import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import admin from "firebase-admin";
import { TwitterApi } from "twitter-api-v2";
import OpenAI from "openai";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import os from "os";
import ytdlp from "yt-dlp-exec";
import dotenv from "dotenv";

admin.initializeApp();
// Load local env vars when running emulator
dotenv.config();
// Set global runtime options (replaces functions.runWith for v2 API)
setGlobalOptions({ region: "us-central1", timeoutSeconds: 540, memory: "1GiB" });

const dbRef = admin.firestore().doc("tokens/demo");
const stateRef = admin.firestore().doc("state/bot");

// Language mapping for Murf API
const LANGUAGE_MAP = {
  French: "fr_FR",
  German: "de_DE",
  Spanish: "es_ES",
  Hindi: "hi_IN",
  Japanese: "ja_JP",
  English: "en_US",
  Korean: "ko_KR",
  Chinese: "zh_CN",
};

// Normalize language input from UI (e.g., "hi", "fr") or names
function normalizeLanguage(input) {
  if (!input) return undefined;
  const trimmed = String(input).trim();
  const lower = trimmed.toLowerCase();
  const isoToName = {
    hi: "Hindi",
    es: "Spanish",
    fr: "French",
    de: "German",
    ja: "Japanese",
    en: "English",
    ko: "Korean",
    zh: "Chinese",
  };
  if (isoToName[lower]) return isoToName[lower];
  // Capitalize first letter for names like "french" → "French"
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const twitterClient = new TwitterApi({
  appKey: process.env.API_KEY,
  appSecret: process.env.API_KEY_SECRET,
  accessToken: process.env.ACCESS_TOKEN,
  accessSecret: process.env.ACCESS_TOKEN_SECRET,
});

// Helper function to extract language from arbitrary text (mention text or tweet text)
async function extractLanguageFromTweet(tweetText) {
  const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
        content: "You are a helpful bot that extracts the desired language for dubbing from a tweet. Respond with only the language in this format: French",
        },
        {
          role: "user",
        content: `Find out the desired output language from: ${tweetText}`,
        },
      ],
    });
  const content = res.choices[0].message.content.trim();
  const match = content.match(/([A-Za-z]+)/);
  if (!match) throw new Error(`Failed to parse language from OpenAI response: ${content}`);
  return match[1];
}

// Extract tweet URL and language from a mention text using OpenAI with regex fallbacks
async function parseMention(text) {
  const fallback = { language: undefined, tweetUrl: undefined };
  if (!text || typeof text !== "string") return fallback;

  // First try quick regex for a tweet URL
  const urlMatch = text.match(/https?:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/(\d+)/);
  const guessedUrl = urlMatch ? urlMatch[0] : undefined;

  // Attempt to extract language token heuristically (simple code words like 'en', 'hi', etc.)
  const isoGuess = text.match(/\b(fr|de|es|hi|ja|en|ko|zh)\b/i);

  // Use OpenAI to robustly parse when ambiguous
  try {
    const prompt = `Extract two fields from the text: 1) language desired for dubbing, 2) tweet URL.\n` +
      `Return JSON strictly as {"language":"<Name or ISO>","tweetUrl":"<URL or empty>"}.\n` +
      `Text: ${text}`;
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You extract {language, tweetUrl} from short messages. Return strict JSON." },
        { role: "user", content: prompt }
      ]
    });
    const content = res.choices?.[0]?.message?.content?.trim();
    try {
      const parsed = JSON.parse(content);
      return {
        language: parsed.language || (isoGuess ? isoGuess[0] : undefined),
        tweetUrl: parsed.tweetUrl || guessedUrl
      };
    } catch {
      return { language: isoGuess ? isoGuess[0] : undefined, tweetUrl: guessedUrl };
    }
  } catch (e) {
    logger.warn("OpenAI parseMention failed, falling back to regex", { error: e.message });
    return { language: isoGuess ? isoGuess[0] : undefined, tweetUrl: guessedUrl };
  }
}

// Helper function to send video to Murf and poll for result
async function sendToMurf(videoPath, language) {
  logger.info(`Starting Murf process for language: ${language}, video: ${videoPath}`);
  const targetLocale = LANGUAGE_MAP[language];
  if (!targetLocale) {
    logger.error(`Language mapping failed. Input: ${language}, Available mappings:`, LANGUAGE_MAP);
    throw new Error(`Unsupported language: ${language}`);
  }

  logger.info(`Creating form data with video file...`);
  const fileStream = fs.createReadStream(videoPath);
  const form = new FormData();
  form.append("file", fileStream, "input.mp4");
  form.append("file_name", "input.mp4");
  form.append("priority", "LOW");
  form.append("target_locales", targetLocale);

  const createResponse = await axios.post(
    "https://api.murf.ai/v1/murfdub/jobs/create",
    form,
    {
      headers: {
        "api-key": process.env.MURF_API_KEY,
        ...form.getHeaders(),
      },
    }
  );

  const jobId = createResponse.data.job_id;
  logger.info("Created Murf Job ID:", jobId);

  // Polling Murf job status every 3 seconds for up to 6 minutes
  const maxRetries = 120;
  const pollingInterval = 3000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const statusResponse = await axios.get(
        `https://api.murf.ai/v1/murfdub/jobs/${jobId}/status`,
        {
          headers: {
            "api-key": process.env.MURF_API_KEY,
          },
        }
      );

      const jobData = statusResponse.data;
      const jobStatus = jobData.status;

      if (jobStatus === "COMPLETED") {
        const details = jobData.download_details?.find((d) => d.download_url);
        if (!details) throw new Error("Murf job completed, but no download details found.");
        logger.info("Murf dubbing completed. Download URL:", details.download_url);
        return details.download_url;
      }

      if (jobStatus === "FAILED") {
        throw new Error(`Murf dubbing failed: ${jobData.failure_reason || "Unknown error"}`);
      }

      logger.info(`[${i + 1}/${maxRetries}] Waiting for Murf job ${jobId} to complete...`);
    } catch (err) {
      logger.error(`Error while polling Murf job status: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, pollingInterval));
  }

  throw new Error("Timeout: Murf job did not complete within expected time");
}

// Helper function to reply with dubbed video
async function replyWithDubbedVideo(originalTweetId, dubbedVideoUrl, language) {
  const tempFile = path.join(os.tmpdir(), "dubbed.mp4");
  const { data } = await axios.get(dubbedVideoUrl, { responseType: "arraybuffer" });
  fs.writeFileSync(tempFile, data);

  const mediaId = await twitterClient.v1.uploadMedia(tempFile, {
    mimeType: "video/mp4",
  });

  await twitterClient.v2.reply(
    `Here is the dubbed video in ${language}:`,
    originalTweetId,
    { media: { media_ids: [mediaId] } }
  );

  // Cleanup
  fs.unlinkSync(tempFile);
  functions.logger.info(`Replied to tweet ${originalTweetId} with video`);
}

// Main function to handle video dubbing
export const handleDubbing = onRequest(async (req, res) => {
  try {
    const { tweetId, targetLanguage } = req.query;
    if (!tweetId) {
      logger.warn("Missing tweetId parameter");
      return res.status(400).send("Missing tweetId");
    }

    // Get tweet details
    const tweet = await twitterClient.v2.get(`tweets/${tweetId}`, {
      expansions: ["attachments.media_keys"],
      "media.fields": ["url", "variants"],
      "tweet.fields": ["text"],
    });

    if (!tweet.data?.attachments?.media_keys) {
      throw new Error("No media found in tweet");
    }

    // Determine language: prefer user selection, else extract
    let language = normalizeLanguage(targetLanguage);
    if (!language) {
      language = await extractLanguageFromTweet(tweet.data.text);
    }
    logger.info(`Detected language: ${language}`);

    // Get video URL
    const videoUrl = tweet.includes.media[0].variants
      .filter((v) => v.content_type === "video/mp4")
      .sort((a, b) => b.bit_rate - a.bit_rate)[0].url;

    // Download video
    const videoPath = path.join(os.tmpdir(), `video_${tweetId}.mp4`);
    await ytdlp(videoUrl, { output: videoPath });

    // Send to Murf for dubbing
    const dubbedVideoUrl = await sendToMurf(videoPath, language);
    logger.info(`Dubbed video URL: ${dubbedVideoUrl}`);

    // Reply with dubbed video
    await replyWithDubbedVideo(tweetId, dubbedVideoUrl, language);

    // Cleanup
    fs.unlinkSync(videoPath);

    res.json({ success: true, language, dubbedVideoUrl });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Lightweight CORS wrapper for cross-origin requests from the extension
function applyCors(req, res) {
  // Allow requests from x.com and localhost
  const allowedOrigins = ['https://x.com', 'http://localhost:3000'];
  const origin = req.headers.origin;
  
  if (allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  } else {
    // For development, allow all origins
    res.set('Access-Control-Allow-Origin', '*');
  }
  
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '3600');
  
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return true;
  }
  return false;
}

// Alias for the extension: same behavior as handleDubbing but with CORS enabled
// Error types for better client handling
const ErrorTypes = {
  DOWNLOAD: "DOWNLOAD_ERROR",
  MURF: "MURF_ERROR",
  LANGUAGE: "LANGUAGE_ERROR",
  TIMEOUT: "TIMEOUT_ERROR",
  NETWORK: "NETWORK_ERROR"
};

// Structured error response
function errorResponse(type, message, details = {}) {
  const error = { type, message, ...details };
  logger.error("Structured error:", error);
  return res.status(500).json({ error });
}

export const dubVideo = onRequest(async (req, res) => {
  // CORS for extension
  if (applyCors(req, res)) return;

  try {
    logger.info(`dubVideo called with params:`, req.query);
    const { tweetUrl, targetLanguage } = req.query;
    
    if (!tweetUrl) {
      logger.warn(`Missing tweetUrl parameter`);
      return res.status(400).json({
        error: {
          type: "VALIDATION_ERROR",
          message: "Missing tweetUrl parameter"
        }
      });
    }

    // Normalize or fallback to English
    const language = normalizeLanguage(targetLanguage) || "English";
    logger.info(`dubVideo: Using language ${language}`);

    // Download the tweet video directly without Twitter API (avoids rate limits)
    logger.info(`Downloading video from tweet URL: ${tweetUrl}`);
    const videoPath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
    
    try {
      await ytdlp(String(tweetUrl), {
        output: videoPath,
        verbose: true
      });
      logger.info(`Video downloaded successfully to: ${videoPath}`);
    } catch (dlError) {
      logger.error(`Video download failed:`, dlError);
      return errorResponse(ErrorTypes.DOWNLOAD, "Failed to download video", {
        details: dlError.message,
        url: tweetUrl
      });
    }

    try {
      // Send to Murf
      const dubbedVideoUrl = await sendToMurf(videoPath, language);
      
      // Cleanup
      try { 
        fs.unlinkSync(videoPath);
        logger.info(`Cleaned up temporary video file: ${videoPath}`);
      } catch (cleanupError) {
        logger.warn(`Failed to cleanup temp file: ${cleanupError.message}`);
      }

      logger.info(`dubVideo completed successfully. Dubbed URL: ${dubbedVideoUrl}`);
      return res.json({ 
        success: true, 
        language, 
        dubbedVideoUrl,
        jobId: dubbedVideoUrl.split('/').pop() // Extract job ID for progress tracking
      });

    } catch (murfError) {
      logger.error(`Murf processing failed:`, murfError);
      return errorResponse(ErrorTypes.MURF, "Failed to process video with Murf", {
        details: murfError.message,
        language
      });
    }
  } catch (error) {
    logger.error(`dubVideo failed with error:`, {
      message: error.message,
      stack: error.stack,
      query: req.query
    });

    // Determine error type
    let type = ErrorTypes.NETWORK;
    let message = "An unexpected error occurred";

    if (error.code === "ECONNABORTED" || error.message.includes("timeout")) {
      type = ErrorTypes.TIMEOUT;
      message = "Request timed out. The video might be too long.";
    } else if (error.message.includes("language")) {
      type = ErrorTypes.LANGUAGE;
      message = "Unsupported language selected.";
    }

    return errorResponse(type, message, {
      originalError: error.message
    });
    }
});

// Webhook-style endpoint to process mentions to our bot account
// Supports two payload shapes:
// 1) Twitter Account Activity API style: { tweet_create_events: [ { id_str, text, user, ... } ] }
// 2) Simplified test payload: { id: "...", text: "@bot please dub ... <tweetUrl>", screen_name: "..." }
export const handleMention = onRequest(async (req, res) => {
  const requestId = `mention_${Date.now()}`;
  try {
    // Normalize payload
    let mention = undefined;
    if (Array.isArray(req.body?.tweet_create_events) && req.body.tweet_create_events.length > 0) {
      mention = req.body.tweet_create_events[0];
    } else if (req.body && req.body.text) {
      mention = req.body;
    }

    if (!mention) {
      logger.warn("handleMention: invalid payload", { requestId, bodyKeys: Object.keys(req.body || {}) });
      return res.status(400).json({ error: "Invalid mention payload" });
    }

    const mentionText = mention.text || "";
    const authorScreenName = mention.user?.screen_name || mention.screen_name || "user";
    logger.info("handleMention: received", { requestId, authorScreenName, text: mentionText });

    // Extract tweet URL and desired language
    const { language: desiredLanguageRaw, tweetUrl } = await parseMention(mentionText);
    if (!tweetUrl) {
      logger.warn("handleMention: missing tweet URL", { requestId, mentionText });
      await twitterClient.v2.tweet({
        text: `@${authorScreenName} I couldn't find a tweet URL in your message. Please include a link to the tweet with the video.`,
        reply: mention.id_str || mention.id ? { in_reply_to_tweet_id: mention.id_str || mention.id } : undefined,
      }).catch((e) => logger.error("reply warn failed", { error: e.message }));
      return res.status(400).json({ error: "Missing tweet URL in mention" });
    }

    const normalizedLanguage = normalizeLanguage(desiredLanguageRaw) || "English";

    // Post a status update: started
    try {
      await twitterClient.v2.tweet({
        text: `@${authorScreenName} Starting dubbing in ${normalizedLanguage}… I will reply with the result shortly.`,
        reply: mention.id_str || mention.id ? { in_reply_to_tweet_id: mention.id_str || mention.id } : undefined,
      });
    } catch (e) {
      logger.warn("handleMention: initial status tweet failed", { error: e.message });
    }

    // Reuse the same flow as dubVideo to process the tweet URL end-to-end
    logger.info("handleMention: downloading video", { requestId, tweetUrl, normalizedLanguage });
    const videoPath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
    try {
      await ytdlp(String(tweetUrl), { output: videoPath, verbose: true });
      logger.info("handleMention: video downloaded", { requestId, videoPath });
    } catch (dlError) {
      logger.error("handleMention: download failed", { requestId, error: dlError.message });
      await twitterClient.v2.tweet({
        text: `@${authorScreenName} I couldn't download that video. The tweet might be private or unsupported.`,
        reply: mention.id_str || mention.id ? { in_reply_to_tweet_id: mention.id_str || mention.id } : undefined,
      }).catch(() => {});
      return res.status(500).json({ error: "Failed to download video", details: dlError.message });
    }

    let dubbedVideoUrl = undefined;
    try {
      dubbedVideoUrl = await sendToMurf(videoPath, normalizedLanguage);
      logger.info("handleMention: dubbing completed", { requestId, dubbedVideoUrl });
    } catch (murfError) {
      logger.error("handleMention: murf failed", { requestId, error: murfError.message });
      await twitterClient.v2.tweet({
        text: `@${authorScreenName} Dubbing failed (${normalizedLanguage}). Please try again later.`,
        reply: mention.id_str || mention.id ? { in_reply_to_tweet_id: mention.id_str || mention.id } : undefined,
      }).catch(() => {});
      return res.status(500).json({ error: "Murf processing failed", details: murfError.message });
    } finally {
      try { fs.unlinkSync(videoPath); } catch {}
    }

    // Reply with the dubbed video link
    try {
      await twitterClient.v2.tweet({
        text: `@${authorScreenName} Here is your dubbed video in ${normalizedLanguage}: ${dubbedVideoUrl}`,
        reply: mention.id_str || mention.id ? { in_reply_to_tweet_id: mention.id_str || mention.id } : undefined,
      });
    } catch (e) {
      logger.error("handleMention: final reply failed", { error: e.message });
    }

    return res.json({ success: true, dubbedVideoUrl, language: normalizedLanguage });
  } catch (error) {
    logger.error("handleMention: unexpected error", { error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

// Scheduled mention poller (avoids Twitter webhooks). Runs every minute by default.
// Reads the bot account mentions, processes new ones, and replies with results.
export const pollMentions = onSchedule("every 1 minutes", async (event) => {
  const requestId = `poll_${Date.now()}`;
  try {
    logger.info("pollMentions: starting", { requestId });
    // Identify bot user id
    const me = await twitterClient.v2.me();
    const botId = me.data?.id;
    if (!botId) {
      logger.error("pollMentions: failed to get bot id");
      return;
    }

    // Fetch last processed id
    const stateSnap = await stateRef.get().catch(() => undefined);
    const sinceId = stateSnap?.exists ? stateSnap.data().lastMentionId : undefined;

    const params = { max_results: 10 };
    if (sinceId) params.since_id = sinceId;
    const timeline = await twitterClient.v2.userMentionTimeline(botId, params);

    if (!timeline?.data?.data?.length) {
      logger.info("pollMentions: no new mentions", { requestId });
      return;
    }

    // Process from oldest to newest
    const mentions = [...timeline.data.data].reverse();
    let newestId = sinceId;

    for (const m of mentions) {
      newestId = m.id; // track newest
      const text = m.text || "";
      const authorId = m.author_id;
      let author = undefined;
      try {
        if (authorId) {
          const user = await twitterClient.v2.user(authorId);
          author = user.data?.username || "user";
        }
      } catch {}

      logger.info("pollMentions: handling mention", { id: m.id, text });
      const { language: desiredLanguageRaw, tweetUrl } = await parseMention(text);
      if (!tweetUrl) {
        await twitterClient.v2.tweet({
          text: `@${author || "user"} Please include a tweet link with a video to dub.`,
          reply: { in_reply_to_tweet_id: m.id }
        }).catch(() => {});
        continue;
      }
      const normalizedLanguage = normalizeLanguage(desiredLanguageRaw) || "English";
      try {
        await twitterClient.v2.tweet({
          text: `@${author || "user"} Dubbing in ${normalizedLanguage}…`,
          reply: { in_reply_to_tweet_id: m.id }
        }).catch(() => {});
      } catch {}

      const videoPath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
      try {
        await ytdlp(String(tweetUrl), { output: videoPath, verbose: true });
      } catch (dlError) {
        logger.error("pollMentions: download failed", { error: dlError.message });
        await twitterClient.v2.tweet({
          text: `@${author || "user"} I couldn't download that video.`,
          reply: { in_reply_to_tweet_id: m.id }
        }).catch(() => {});
        continue;
      }

      try {
        const dubbedVideoUrl = await sendToMurf(videoPath, normalizedLanguage);
        await twitterClient.v2.tweet({
          text: `@${author || "user"} Here is your dubbed video in ${normalizedLanguage}: ${dubbedVideoUrl}`,
          reply: { in_reply_to_tweet_id: m.id }
        }).catch(() => {});
      } catch (murfError) {
        logger.error("pollMentions: murf failed", { error: murfError.message });
        await twitterClient.v2.tweet({
          text: `@${author || "user"} Dubbing failed (${normalizedLanguage}). Please try again later.`,
          reply: { in_reply_to_tweet_id: m.id }
        }).catch(() => {});
      } finally {
        try { fs.unlinkSync(videoPath); } catch {}
      }
    }

    if (newestId && newestId !== sinceId) {
      await stateRef.set({ lastMentionId: newestId }, { merge: true });
    }
    logger.info("pollMentions: done", { requestId, updatedSince: sinceId, newestId });
  } catch (e) {
    logger.error("pollMentions: unexpected error", { error: e.message });
  }
});
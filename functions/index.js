import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
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

// Helper function to extract language from tweet text
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

// Webhook endpoint for Twitter to notify us about new mentions
export const handleMention = onRequest(async (req, res) => {
  try {
    const { tweet_create_events } = req.body;
    if (!tweet_create_events) return res.status(400).send("No tweet event found");

    const tweet = tweet_create_events[0];
    if (!tweet.in_reply_to_status_id_str) {
      return res.status(400).send("Not a reply tweet");
    }

    // Trigger dubbing process
    const originalTweetId = tweet.in_reply_to_status_id_str;
    await handleDubbing({ query: { tweetId: originalTweetId } }, res);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: error.message });
  }
});
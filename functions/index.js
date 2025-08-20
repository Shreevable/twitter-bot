import {onRequest} from "firebase-functions/v2/https";
import {setGlobalOptions} from "firebase-functions/v2/options";
import {onSchedule} from "firebase-functions/v2/scheduler";
import functionsV1 from "firebase-functions";
import * as logger from "firebase-functions/logger";
import admin from "firebase-admin";
import {TwitterApi} from "twitter-api-v2";
import OpenAI from "openai";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import os from "os";
import getTwitterMedia from "get-twitter-media";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

admin.initializeApp();

setGlobalOptions({region: "us-central1", timeoutSeconds: 540, memory: "1GiB"});

const db = admin.firestore();
const stateRef = db.doc("state/bot");
const processedTweetsRef = db.collection("processedTweets");

const runtimeConfig = (() => {
  try {
    return functionsV1.config();
  } catch {
    return {};
  }
})();

function getConfig(key, ns, nsKey) {
  return process.env[key] || (runtimeConfig?.[ns]?.[nsKey]);
}

const twitterKeys = {
  appKey: getConfig("API_KEY", "twitter", "api_key"),
  appSecret: getConfig("API_KEY_SECRET", "twitter", "api_key_secret"),
  accessToken: getConfig("ACCESS_TOKEN", "twitter", "access_token"),
  accessSecret: getConfig("ACCESS_TOKEN_SECRET", "twitter", "access_token_secret"),
};
const openaiKey = getConfig("OPENAI_API_KEY", "openai", "key");
const murfKey = getConfig("MURF_API_KEY", "murf", "key");

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
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

let openai;
let twitterClient;

try {
  openai = new OpenAI({apiKey: openaiKey});
  twitterClient = new TwitterApi(twitterKeys);
} catch (e) {
  logger.error("Failed to initialize API clients", {error: e.message});
}

async function parseMention(text) {
  const fallback = {language: undefined, tweetUrl: undefined};
  if (!text || typeof text !== "string") return fallback;

  const urlMatch = text.match(/https?:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/(\d+)/);
  const guessedUrl = urlMatch ? urlMatch[0] : undefined;

  const isoGuess = text.match(/\b(fr|de|es|hi|ja|en|ko|zh)\b/i);

  try {
    const prompt = `Extract two fields from the text: 1) language desired for dubbing, 2) tweet URL.\n` +
      `Return JSON strictly as {"language":"<Name or ISO>","tweetUrl":"<URL or empty>"}.\n` +
      `Text: ${text}`;
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {role: "system", content: "You extract {language, tweetUrl} from short messages. Return strict JSON."},
        {role: "user", content: prompt},
      ],
    });
    const content = res.choices?.[0]?.message?.content?.trim();
    try {
      const parsed = JSON.parse(content);
      return {
        language: parsed.language || (isoGuess ? isoGuess[0] : undefined),
        tweetUrl: parsed.tweetUrl || guessedUrl,
      };
    } catch {
      return {language: isoGuess ? isoGuess[0] : undefined, tweetUrl: guessedUrl};
    }
  } catch (e) {
    logger.warn("OpenAI parseMention failed, falling back to regex", {error: e.message});
    return {language: isoGuess ? isoGuess[0] : undefined, tweetUrl: guessedUrl};
  }
}

async function sendToMurf(videoPath, language) {
  logger.info(`Starting Murf process for language: ${language}, video: ${videoPath}`);
  const targetLocale = LANGUAGE_MAP[language];
  if (!targetLocale) {
    logger.error(`Language mapping failed. Input: ${language}, Available mappings:`, LANGUAGE_MAP);
    throw new Error(`Unsupported language: ${language}`);
  }

  logger.info("Creating form data with video file...");
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
          "api-key": murfKey,
          ...form.getHeaders(),
        },
      },
  );

  const jobId = createResponse.data.job_id;
  logger.info("Created Murf Job ID:", jobId);

  const maxRetries = 120;
  const pollingInterval = 3000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const statusResponse = await axios.get(
          `https://api.murf.ai/v1/murfdub/jobs/${jobId}/status`,
          {
            headers: {
              "api-key": murfKey,
            },
          },
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

export const handleMention = onRequest(async (req, res) => {
  const requestId = `mention_${Date.now()}`;
  try {
    let mention = undefined;
    if (Array.isArray(req.body?.tweet_create_events) && req.body.tweet_create_events.length > 0) {
      mention = req.body.tweet_create_events[0];
    } else if (req.body && req.body.text) {
      mention = req.body;
    }

    if (!mention) {
      logger.warn("handleMention: invalid payload", {requestId, bodyKeys: Object.keys(req.body || {})});
      return res.status(400).json({error: "Invalid mention payload"});
    }

    const mentionText = mention.text || "";
    const authorScreenName = mention.user?.screen_name || mention.screen_name || "user";
    logger.info("handleMention: received", {requestId, authorScreenName, text: mentionText});

    const {language: desiredLanguageRaw, tweetUrl} = await parseMention(mentionText);
    if (!tweetUrl) {
      logger.warn("handleMention: missing tweet URL", {requestId, mentionText});
      await twitterClient.v2.tweet({
        text: `@${authorScreenName} I couldn't find a tweet URL in your message. Please include a link to the tweet with the video.`,
        reply: mention.id_str || mention.id ? {in_reply_to_tweet_id: mention.id_str || mention.id} : undefined,
      }).catch((e) => logger.error("reply warn failed", {error: e.message}));
      return res.status(400).json({error: "Missing tweet URL in mention"});
    }

    const normalizedLanguage = normalizeLanguage(desiredLanguageRaw) || "English";

    try {
      await twitterClient.v2.tweet({
        text: `@${authorScreenName} Starting dubbing in ${normalizedLanguage}… I will reply with the result shortly.`,
        reply: mention.id_str || mention.id ? {in_reply_to_tweet_id: mention.id_str || mention.id} : undefined,
      });
    } catch (e) {
      logger.warn("handleMention: initial status tweet failed", {error: e.message});
    }

    logger.info("handleMention: downloading video", {requestId, tweetUrl, normalizedLanguage});
    const videoPath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
    try {
      const videoData = await getTwitterMedia(tweetUrl, {
        buffer: true,
      });
      fs.writeFileSync(videoPath, videoData.media[0].buffer);
      logger.info("handleMention: video downloaded", {requestId, videoPath});
    } catch (dlError) {
      logger.error("handleMention: download failed", {requestId, error: dlError.message});
      await twitterClient.v2.tweet({
        text: `@${authorScreenName} I couldn't download that video. The tweet might be private or unsupported.`,
        reply: mention.id_str || mention.id ? {in_reply_to_tweet_id: mention.id_str || mention.id} : undefined,
      }).catch(() => {});
      return res.status(500).json({error: "Failed to download video", details: dlError.message});
    }

    let dubbedVideoUrl = undefined;
    try {
      dubbedVideoUrl = await sendToMurf(videoPath, normalizedLanguage);
      logger.info("handleMention: dubbing completed", {requestId, dubbedVideoUrl});
    } catch (murfError) {
      logger.error("handleMention: murf failed", {requestId, error: murfError.message});
      await twitterClient.v2.tweet({
        text: `@${authorScreenName} Dubbing failed (${normalizedLanguage}). Please try again later.`,
        reply: mention.id_str || mention.id ? {in_reply_to_tweet_id: mention.id_str || mention.id} : undefined,
      }).catch(() => {});
      return res.status(500).json({error: "Murf processing failed", details: murfError.message});
    } finally {
      try {
        fs.unlinkSync(videoPath);
      } catch (e) {
        logger.warn(`Could not unlink video path ${videoPath}`, e);
      }
    }

    try {
      // Download the dubbed video from Murf
      logger.info("handleMention: downloading dubbed video", {requestId, url: dubbedVideoUrl});
      const videoResponse = await axios({
        method: 'GET',
        url: dubbedVideoUrl,
        responseType: 'arraybuffer'
      });
      
      // Upload video to Twitter
      logger.info("handleMention: uploading to Twitter", {requestId});
      const mediaId = await twitterClient.v1.uploadMedia(videoResponse.data, {
        mimeType: 'video/mp4'
      });
      
      // Reply with the dubbed video attached
      await twitterClient.v2.tweet({
        text: `@${authorScreenName} Here's your video dubbed in ${normalizedLanguage}! 🎙️`,
        reply: mention.id_str || mention.id ? {in_reply_to_tweet_id: mention.id_str || mention.id} : undefined,
        media: {media_ids: [mediaId]}
      });
    } catch (e) {
      logger.error("handleMention: final reply failed", {error: e.message});
    }

    return res.json({success: true, dubbedVideoUrl, language: normalizedLanguage});
  } catch (error) {
    logger.error("handleMention: unexpected error", {error: error.message});
    return res.status(500).json({error: error.message});
  }
});

// Optimized polling - reduced frequency to avoid rate limits during processing
export const pollMentions = onSchedule("every 30 minutes", async (event) => {
  await doPollMentions();
});

async function doPollMentions() {
  const requestId = `poll_${Date.now()}`;
  try {
    // Check if already processing to avoid overlapping requests
    if (processedTweetsRef && processedTweetsRef.parent) {
      const processingDoc = await processedTweetsRef.parent.doc('processing').get();
      if (processingDoc.exists && processingDoc.data().active) {
        logger.info("pollMentions: skipping - already processing", {requestId});
        return;
      }
    }
    
    logger.info("pollMentions: starting", {requestId});
    
    // Add rate limiting protection
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    
    // Use hardcoded bot ID to avoid rate limiting on me() calls
    // You can get this from your Twitter Developer Portal or by running me() once
    const botId = "1957937770741264385"; // @dubbing1234 bot ID
    
    if (!botId) {
      logger.error("pollMentions: bot ID not configured");
      return;
    }
    const stateSnap = await stateRef.get().catch(() => undefined);
    const sinceId = stateSnap?.exists ? stateSnap.data().lastMentionId : undefined;
      
      // Add delay before timeline call
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      let timeline;
      try {
        // Use userMentionTimeline with proper parameters
        const params = {
          max_results: 10,
          'tweet.fields': ['created_at', 'author_id', 'conversation_id'],
          'user.fields': ['username'],
          expansions: ['author_id']
        };
        
        // Add since_id if we have one to get only new mentions
        if (sinceId) {
          params.since_id = sinceId;
        }
        
        // This should get mentions TO the bot user
        timeline = await twitterClient.v2.userMentionTimeline(botId, params);
        logger.info("pollMentions: API call successful", {requestId, dataLength: timeline?.data?.data?.length});
      } catch (timelineError) {
        logger.error("pollMentions: API error", {
          error: timelineError.message,
          code: timelineError.code,
          data: timelineError.data,
          requestId
        });
        
        if (timelineError.code === 429) {
          logger.warn("Rate limited on timeline call, skipping this run", {requestId});
          return;
        }
        throw timelineError;
      }
    if (!timeline?.data?.data?.length) {
      logger.info("pollMentions: no new mentions", {requestId});
      return;
    }

    const authors = timeline.includes?.users || [];
    const authorMap = new Map(authors.map((a) => [a.id, a.username]));

    // Filter out the bot's own tweets and get only mentions TO the bot
    const mentions = timeline.data.data
      .filter(tweet => tweet.author_id !== botId) // Exclude bot's own tweets
      .filter(tweet => tweet.text.includes('@dubbing1234')) // Only tweets mentioning the bot
      .reverse();
    let newestId = sinceId;
    for (const m of mentions) {
      newestId = m.id;
      const text = m.text || "";
      const authorId = m.author_id;
      const author = authorMap.get(authorId) || "user";

      // Check if tweet has been processed
      if (processedTweetsRef) {
        const tweetDoc = await processedTweetsRef.doc(m.id).get();
        if (tweetDoc.exists) {
          logger.info("Skipping already processed tweet", {id: m.id});
          continue;
        }
      }

      logger.info("pollMentions: handling mention", {id: m.id, text, author});
      const {language: desiredLanguageRaw, tweetUrl} = await parseMention(text);
      if (!tweetUrl) {
        // Skip - no video found, no need to reply
        continue;
      }
      const normalizedLanguage = normalizeLanguage(desiredLanguageRaw) || "English";
      try {
        // Process silently - no progress tweets
      } catch (e) {
        logger.warn(`Could not post initial reply for ${m.id}`, e);
      }
      const videoPath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
      try {
        const videoData = await getTwitterMedia(tweetUrl, {
          buffer: true,
        });
        fs.writeFileSync(videoPath, videoData.media[0].buffer);
      } catch (dlError) {
        logger.error("pollMentions: download failed", {error: dlError.message});
        // Skip silently - no error tweets
        continue;
      }
      try {
        const dubbedVideoUrl = await sendToMurf(videoPath, normalizedLanguage);
        
        // Download the dubbed video from Murf
        logger.info("Downloading dubbed video from Murf", {url: dubbedVideoUrl});
        const videoResponse = await axios({
          method: 'GET',
          url: dubbedVideoUrl,
          responseType: 'arraybuffer'
        });
        
        // Upload video to Twitter
        logger.info("Uploading dubbed video to Twitter");
        const mediaId = await twitterClient.v1.uploadMedia(videoResponse.data, {
          mimeType: 'video/mp4'
        });
        
        // Reply with the dubbed video attached
        const replyText = `@${author || "user"} Here's your video dubbed in ${normalizedLanguage}! 🎙️`;
        await twitterClient.v2.tweet({
          text: replyText, 
          reply: {in_reply_to_tweet_id: m.id},
          media: {media_ids: [mediaId]}
        }).catch(() => {});
        
        if (processedTweetsRef) {
          await processedTweetsRef.doc(m.id).set({status: "processed", timestamp: new Date()});
        }
      } catch (murfError) {
        logger.error("pollMentions: murf failed", {error: murfError.message});
        // Skip silently - no error tweets  
      } finally {
        try {
          fs.unlinkSync(videoPath);
        } catch (e) {
          logger.warn(`Could not unlink video path ${videoPath}`, e);
        }
      }
    }
    if (newestId && newestId !== sinceId) {
      await stateRef.set({lastMentionId: newestId}, {merge: true});
    }
    logger.info("pollMentions: done", {requestId, updatedSince: sinceId, newestId});
  } catch (e) {
    logger.error("pollMentions: unexpected error", {
      error: e.message,
      stack: e.stack,
      requestId,
    });
  }
}

export const pollMentionsHttp = onRequest(async (req, res) => {
  try {
    await doPollMentions();
    return res.json({success: true});
  } catch (e) {
    return res.status(500).json({error: e.message});
  }
});

// Debug function to get bot account info
export const getBotInfo = onRequest(async (req, res) => {
  try {
    const me = await twitterClient.v2.me();
    return res.json({
      id: me.data.id,
      username: me.data.username,
      name: me.data.name,
      message: `Your bot handle is: @${me.data.username}`
    });
  } catch (e) {
    return res.status(500).json({error: e.message});
  }
});

// Direct tweet processing endpoint - no polling needed!
export const processTweetDirect = onRequest(async (req, res) => {
  const requestId = `direct_${Date.now()}`;
  
  try {
    const tweetId = req.query.tweetId || req.body.tweetId;
    
    if (!tweetId) {
      return res.status(400).json({error: "Missing tweetId parameter. Use ?tweetId=YOUR_TWEET_ID"});
    }
    
    logger.info("processTweetDirect: starting", {requestId, tweetId});
    
    // Get the tweet directly using Twitter API (with media info for efficiency)
    const tweet = await twitterClient.v2.singleTweet(tweetId, {
      expansions: ['author_id', 'attachments.media_keys'],
      'user.fields': ['username'],
      'media.fields': ['url', 'variants', 'type']
    });
    
    if (!tweet.data) {
      return res.status(404).json({error: "Tweet not found or not accessible"});
    }
    
    const tweetText = tweet.data.text;
    const author = tweet.includes?.users?.[0];
    const authorScreenName = author?.username || "unknown";
    
    logger.info("processTweetDirect: found tweet", {requestId, tweetId, text: tweetText, author: authorScreenName});
    
    // Check if it mentions our bot
    if (!tweetText.includes('@dubbing1234')) {
      return res.status(400).json({error: "Tweet doesn't mention @dubbing1234"});
    }
    
    // Parse the mention for language and video URL
    const {language: desiredLanguageRaw, tweetUrl} = await parseMention(tweetText);
    
    const normalizedLanguage = normalizeLanguage(desiredLanguageRaw) || "English";
    
    logger.info("processTweetDirect: processing", {requestId, tweetId, language: normalizedLanguage, parsedUrl: tweetUrl});
    
    // Reply to let them know we're starting
    try {
      await twitterClient.v2.tweet({
        text: `@${authorScreenName} Starting dubbing in ${normalizedLanguage}… I will reply with the result shortly.`,
        reply: {in_reply_to_tweet_id: tweetId}
      });
    } catch (e) {
      logger.warn("processTweetDirect: initial reply failed", {error: e.message});
    }
    
    // Download video - try multiple approaches
    let videoPath;
    try {
      let videoUrl = null;
      
      // Check if this tweet has media attachments (already fetched above)
      if (tweet.includes?.media?.length > 0) {
        const videoMedia = tweet.includes.media.find(m => m.type === 'video');
        if (videoMedia && videoMedia.variants) {
          // Get the highest quality MP4 variant
          const mp4Variant = videoMedia.variants
            .filter(v => v.content_type === 'video/mp4')
            .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
          if (mp4Variant) {
            videoUrl = mp4Variant.url;
            logger.info("processTweetDirect: found video in tweet media", {requestId, videoUrl});
          }
        }
      }
      
      // If no video found in tweet media, try the parsed URL
      if (!videoUrl && tweetUrl) {
        try {
          videoUrl = await getTwitterMedia(tweetUrl, {type: "video"});
          logger.info("processTweetDirect: got video from parsed URL", {requestId, videoUrl});
        } catch (e) {
          logger.warn("processTweetDirect: failed to get video from parsed URL", {requestId, error: e.message});
        }
      }
      
      if (!videoUrl) {
        throw new Error("No video found in tweet or referenced URL");
      }
      
      const response = await axios.get(videoUrl, {responseType: "arraybuffer"});
      const videoBuffer = Buffer.from(response.data);
      
      videoPath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
      fs.writeFileSync(videoPath, videoBuffer);
      
      logger.info("processTweetDirect: video downloaded", {requestId, videoPath, size: videoBuffer.length});
    } catch (dlError) {
      logger.error("processTweetDirect: download failed", {requestId, error: dlError.message});
      return res.status(500).json({error: "Failed to download video", details: dlError.message});
    }
    
    // Send to Murf for dubbing
    let dubbedVideoUrl;
    try {
      dubbedVideoUrl = await sendToMurf(videoPath, normalizedLanguage);
      logger.info("processTweetDirect: dubbing completed", {requestId, dubbedVideoUrl});
    } catch (murfError) {
      logger.error("processTweetDirect: murf failed", {requestId, error: murfError.message});
      return res.status(500).json({error: "Murf processing failed", details: murfError.message});
    } finally {
      // Clean up video file
      try {
        fs.unlinkSync(videoPath);
      } catch (e) {
        logger.warn(`Could not unlink video path ${videoPath}`, e);
      }
    }
    
    // Download the dubbed video and reply with it attached
    try {
      // Download the dubbed video from Murf
      logger.info("processTweetDirect: downloading dubbed video", {requestId, url: dubbedVideoUrl});
      const videoResponse = await axios({
        method: 'GET',
        url: dubbedVideoUrl,
        responseType: 'arraybuffer'
      });
      
      // Upload video to Twitter
      logger.info("processTweetDirect: uploading to Twitter", {requestId});
      const mediaId = await twitterClient.v1.uploadMedia(videoResponse.data, {
        mimeType: 'video/mp4'
      });
      
      // Reply with the dubbed video attached
      await twitterClient.v2.tweet({
        text: `@${authorScreenName} Here's your video dubbed in ${normalizedLanguage}! 🎙️`,
        reply: {in_reply_to_tweet_id: tweetId},
        media: {media_ids: [mediaId]}
      });
      
      logger.info("processTweetDirect: completed successfully", {requestId, tweetId, language: normalizedLanguage});
    } catch (e) {
      logger.error("processTweetDirect: final reply failed", {error: e.message});
    }
    
    return res.json({
      success: true,
      tweetId,
      language: normalizedLanguage,
      dubbedVideoUrl,
      message: "Tweet processed successfully!"
    });
    
  } catch (error) {
    logger.error("processTweetDirect: unexpected error", {requestId, error: error.message});
    return res.status(500).json({error: error.message});
  }
});

/**
 * Twitter Webhook endpoint - receives mention events directly from Twitter
 */
export const twitterWebhook = onRequest(async (req, res) => {
  try {
    logger.info("twitterWebhook: received request", {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });

    // Handle Twitter's CRC (Challenge Response Check) for webhook verification
    if (req.method === "GET" && req.query.crc_token) {
      const crcToken = req.query.crc_token;
      const responseToken = createCrcResponse(crcToken);
      logger.info("twitterWebhook: CRC challenge", {crcToken, responseToken});
      return res.json({response_token: responseToken});
    }

    // Handle actual webhook events (POST requests)
    if (req.method === "POST") {
      await processWebhookEvent(req.body);
      return res.json({success: true});
    }

    res.status(400).json({error: "Invalid request method"});
  } catch (error) {
    logger.error("twitterWebhook: error", {error: error.message, stack: error.stack});
    res.status(500).json({error: error.message});
  }
});

/**
 * Creates CRC response for Twitter webhook verification
 * @param {string} crcToken - The CRC token from Twitter
 * @returns {string} The response token
 */
function createCrcResponse(crcToken) {
  const consumerSecret = getConfig("API_KEY_SECRET", "twitter", "api_key_secret");
  
  const hmac = crypto.createHmac("sha256", consumerSecret);
  hmac.update(crcToken);
  return "sha256=" + hmac.digest("base64");
}

/**
 * Processes webhook events from Twitter
 * @param {Object} eventData - The webhook event data from Twitter
 */
async function processWebhookEvent(eventData) {
  const requestId = `webhook_${Date.now()}`;
  
  try {
    logger.info("processWebhookEvent: processing", {requestId, eventData});

    // Check if this is a tweet_create event with mentions
    if (eventData.tweet_create_events) {
      for (const tweet of eventData.tweet_create_events) {
        await processMentionTweet(tweet, requestId);
      }
    }
    
    logger.info("processWebhookEvent: completed", {requestId});
  } catch (error) {
    logger.error("processWebhookEvent: error", {
      error: error.message,
      stack: error.stack,
      requestId,
    });
    throw error;
  }
}

/**
 * Processes a single mention tweet from webhook
 * @param {Object} tweet - The tweet data from Twitter webhook
 * @param {string} requestId - Request ID for logging
 */
async function processMentionTweet(tweet, requestId) {
  try {
    const tweetId = tweet.id_str;
    const text = tweet.text || "";
    const authorScreenName = tweet.user?.screen_name || "user";
    
    logger.info("processMentionTweet: handling", {
      tweetId,
      text,
      author: authorScreenName,
      requestId,
    });

    // Check if tweet has been processed already
    if (processedTweetsRef) {
      const tweetDoc = await processedTweetsRef.doc(tweetId).get();
      if (tweetDoc.exists) {
        logger.info("processMentionTweet: already processed", {tweetId, requestId});
        return;
      }
    }

    // Parse the mention for language and video URL
    const {language: desiredLanguageRaw, tweetUrl} = await parseMention(text);
    
    if (!tweetUrl) {
      const replyText = `@${authorScreenName} Please include a tweet link with a video to dub.`;
      await twitterClient.v2.tweet({
        text: replyText,
        reply: {in_reply_to_tweet_id: tweetId},
      }).catch(() => {});
      return;
    }

    const normalizedLanguage = normalizeLanguage(desiredLanguageRaw) || "English";

    // Send initial reply
    try {
      const replyText = `@${authorScreenName} Dubbing in ${normalizedLanguage}…`;
      await twitterClient.v2.tweet({
        text: replyText,
        reply: {in_reply_to_tweet_id: tweetId},
      }).catch(() => {});
    } catch (e) {
      logger.warn(`Could not post initial reply for ${tweetId}`, e);
    }

    // Process the video
    const videoPath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
    
    try {
      // Download video with detailed logging
      logger.info("processMentionTweet: starting video download", {
        tweetUrl,
        tweetId,
        requestId,
      });
      
      const videoData = await getTwitterMedia(tweetUrl);
      
      logger.info("processMentionTweet: video metadata received", {
        hasVideoData: !!videoData,
        hasMedia: !!videoData?.media,
        mediaLength: videoData?.media?.length,
        firstMediaUrl: videoData?.media?.[0]?.url,
        tweetId,
        requestId,
      });
      
      if (!videoData || !videoData.media || !videoData.media[0] || !videoData.media[0].url) {
        throw new Error("No video URL found in tweet");
      }
      
      // Download the video from the URL
      const videoUrl = videoData.media[0].url;
      logger.info("processMentionTweet: downloading video from URL", {
        videoUrl,
        tweetId,
        requestId,
      });
      
      const response = await axios({
        method: "GET",
        url: videoUrl,
        responseType: "arraybuffer",
      });
      
      logger.info("processMentionTweet: video downloaded", {
        dataSize: response.data.length,
        contentType: response.headers["content-type"],
        tweetId,
        requestId,
      });
      
      fs.writeFileSync(videoPath, response.data);

      // Send to Murf for dubbing
      const dubbedVideoUrl = await sendToMurf(videoPath, normalizedLanguage);

      // Download the dubbed video and reply with it attached
      logger.info("processMentionTweet: downloading dubbed video", {requestId, url: dubbedVideoUrl});
      const videoResponse = await axios({
        method: 'GET',
        url: dubbedVideoUrl,
        responseType: 'arraybuffer'
      });
      
      // Upload video to Twitter
      logger.info("processMentionTweet: uploading to Twitter", {requestId});
      const mediaId = await twitterClient.v1.uploadMedia(videoResponse.data, {
        mimeType: 'video/mp4'
      });
      
      // Reply with the dubbed video attached
      const replyText = `@${authorScreenName} Here's your video dubbed in ${normalizedLanguage}! 🎙️`;
      await twitterClient.v2.tweet({
        text: replyText,
        reply: {in_reply_to_tweet_id: tweetId},
        media: {media_ids: [mediaId]}
      }).catch(() => {});

      // Mark as processed
      if (processedTweetsRef) {
        await processedTweetsRef.doc(tweetId).set({
          status: "processed",
          timestamp: new Date(),
          language: normalizedLanguage,
        });
      }

      logger.info("processMentionTweet: completed successfully", {
        tweetId,
        language: normalizedLanguage,
        requestId,
      });

    } catch (processingError) {
      // Handle both download and dubbing errors
      logger.error("processMentionTweet: processing failed", {
        error: processingError.message,
        tweetId,
        requestId,
      });
      
      let replyText;
      if (processingError.message.includes("download")) {
        replyText = `@${authorScreenName} I couldn't download that video.`;
      } else {
        replyText = `@${authorScreenName} Dubbing failed (${normalizedLanguage}). Please try again later.`;
      }
      
      await twitterClient.v2.tweet({
        text: replyText,
        reply: {in_reply_to_tweet_id: tweetId},
      }).catch(() => {});
    } finally {
      // Clean up video file
      try {
        fs.unlinkSync(videoPath);
      } catch (e) {
        logger.warn(`Could not unlink video path ${videoPath}`, e);
      }
    }

  } catch (error) {
    logger.error("processMentionTweet: unexpected error", {
      error: error.message,
      stack: error.stack,
      tweetId: tweet.id_str,
      requestId,
    });
  }
}
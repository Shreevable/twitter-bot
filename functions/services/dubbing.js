import functions from "firebase-functions";
import {LANGUAGE_MAP, MURF_CONFIG, VOICE_MAP} from "../config/murf.js";
import {getStoragePath, getTempFileUrl} from "../config/storage.js";
import {retryOperation} from "../utils/error.js";
import {twitterClient} from "../config/twitter.js";
import axios from "axios";
import FormData from "form-data";
import {getStorage} from "firebase-admin/storage";

export const handleDubbing = async ({tweetId, requestTweetId, requestText}) => {
  try {
    // Extract language from request
    const language = await extractLanguageFromText(requestText);
    functions.logger.info(`Detected language: ${language}`);

    // Get video from tweet
    const tweet = await retryOperation(() =>
      twitterClient.v2.get(`tweets/${tweetId}`, {
        "expansions": ["attachments.media_keys"],
        "media.fields": ["url", "variants"],
      }),
    );

    if (!tweet.includes?.media?.some((media) => media.type === "video")) {
      throw new Error("No video found in tweet");
    }

    const videoUrl = tweet.includes.media[0].variants
        .filter((v) => v.content_type === "video/mp4")
        .sort((a, b) => b.bit_rate - a.bit_rate)[0].url;

    // Download and process video
    const videoPath = await downloadVideo(videoUrl, tweetId);
    const dubbedVideoUrl = await sendToMurf(videoPath, language);

    // Reply with dubbed video
    await replyWithDubbedVideo(requestTweetId, dubbedVideoUrl, language);

    return {success: true, language, dubbedVideoUrl};
  } catch (error) {
    functions.logger.error("Error in handleDubbing:", error);
    throw error;
  }
};

/**
 * Extracts language from text using OpenAI.
 * @param {string} text The text to extract language from.
 * @return {Promise<string>} The extracted language.
 */
async function extractLanguageFromText(text) {
  // Implementation from your existing code
  // This should use OpenAI to extract the language
  return "English"; // Placeholder
}

/**
 * Downloads a video from a URL.
 * @param {string} videoUrl The URL of the video to download.
 * @param {string} tweetId The ID of the tweet.
 * @return {Promise<string>} The path to the downloaded video.
 */
async function downloadVideo(videoUrl, tweetId) {
  const response = await axios({
    method: "GET",
    url: videoUrl,
    responseType: "stream",
  });

  const videoPath = getStoragePath("videos", `${tweetId}.mp4`);
  const storage = getStorage();
  await storage.bucket().file(videoPath).save(response.data);

  return videoPath;
}

/**
 * Sends a video to Murf for dubbing.
 * @param {string} videoPath The path to the video file.
 * @param {string} language The target language.
 * @return {Promise<string>} The URL of the dubbed video.
 */
async function sendToMurf(videoPath, language) {
  const targetLocale = LANGUAGE_MAP[language];
  if (!targetLocale) throw new Error(`Unsupported language: ${language}`);

  const videoUrl = await getTempFileUrl(videoPath);
  const form = new FormData();

  form.append("video_url", videoUrl);
  form.append("target_locale", targetLocale);
  form.append("voice_id", VOICE_MAP[targetLocale]);

  const response = await retryOperation(() =>
    axios.post(`${MURF_CONFIG.baseUrl}/dub`, form, {
      headers: {
        "api-key": MURF_CONFIG.apiKey,
        ...form.getHeaders(),
      },
    }),
  );

  return response.data.dubbed_video_url;
}

/**
 * Replies to a tweet with a dubbed video.
 * @param {string} replyToTweetId The ID of the tweet to reply to.
 * @param {string} dubbedVideoUrl The URL of the dubbed video.
 * @param {string} language The language of the dubbed video.
 */
async function replyWithDubbedVideo(replyToTweetId, dubbedVideoUrl, language) {
  const videoResponse = await axios({
    method: "GET",
    url: dubbedVideoUrl,
    responseType: "arraybuffer",
  });

  const mediaId = await twitterClient.v1.uploadMedia(videoResponse.data, {
    mimeType: "video/mp4",
  });

  await twitterClient.v2.reply(
      `Here's your video dubbed in ${language}! 🎙️`,
      replyToTweetId,
      {media: {media_ids: [mediaId]}},
  );
}

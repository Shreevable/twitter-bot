import functions from "firebase-functions";
import admin from "firebase-admin";
import { TwitterApi } from "twitter-api-v2";
import OpenAI from "openai";
import fetch from "node-fetch"; // Using node-fetch as per your existing code, omitting axios as requested

admin.initializeApp();

const dbRef = admin.firestore().doc("tokens/demo");

import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const twitterClient = new TwitterApi({
  clientId: process.env.CLIENT_ID, // Using environment variables as per your latest code
  clientSecret: process.env.CLIENT_SECRET, // Using environment variables as per your latest code
});

const callbackUrl =
  "http://localhost:5000/project-4261681351/us-central1/callback";

export const auth = functions.https.onRequest(async (req, res) => {
  const { url, codeVerifier, state } = twitterClient.generateOAuth2AuthLink(
    callbackUrl,
    { scope: ["tweet.read", "users.read", "offline.access"] }
  );

  await dbRef.set({ codeVerifier, state });

  res.redirect(url);
});

export const callback = functions.https.onRequest(async (req, res) => {
  const { state, code } = req.query;

  const dbSnapshot = await dbRef.get();
  const { codeVerifier, state: storedState } = dbSnapshot.data();

  if (state !== storedState) {
    res.status(400).send("Stored tokens do not match");
  }

  const {
    client: loggedClient,
    accessToken,
    refreshToken,
  } = await twitterClient.loginWithOAuth2({
    code,
    codeVerifier,
    redirectUri: callbackUrl,
  });

  await dbRef.set({ accessToken, refreshToken });

  res.redirect("https://x.com")
});

export const summarizeTweet = functions.https.onRequest(async (req, res) => {
  try {
    const tweetId = req.query.tweetId;
    if (!tweetId) {
      functions.logger.warn("Missing tweetId in request.");
      res.status(400).send("Missing tweetId");
      return;
    }

    const snapshot = await dbRef.get();
    const { accessToken, refreshToken } = snapshot.data();

    let client = new TwitterApi(accessToken);
    let tweet;

    try {
      tweet = await client.v2.singleTweet(tweetId);
      functions.logger.info(`Successfully fetched tweet: ${tweetId}`);
    } catch (err) {
      functions.logger.warn(
        "Access token may have expired, attempting refresh...",
        err
      );
      const {
        client: refreshedClient,
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      } = await twitterClient.refreshOAuth2Token(refreshToken);

      await dbRef.set({
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      });

      client = refreshedClient;
      tweet = await client.v2.singleTweet(tweetId); // Retry tweet fetch
      functions.logger.info(
        `Successfully refreshed token and fetched tweet: ${tweetId}`
      );
    }

    const tweetText = tweet.data.text;
    functions.logger.info(
      `Tweet text for summarization: "${tweetText.substring(0, 100)}..."`
    ); // Log first 100 chars

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful bot that summarizes the text written in a tweet.",
        },
        {
          role: "user",
          content: `Summarize this tweet: "${tweetText}"`,
        },
      ],
    });

    const summary = completion.choices[0].message.content;
    functions.logger.info(
      `Generated summary: "${summary.substring(0, 100)}..."`
    ); // Log first 100 chars of summary

    functions.logger.info("Sending request to Murf.ai...");
    const response = await fetch("https://api.murf.ai/v1/speech/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.MURFAI_API_KEY,
      },
      body: JSON.stringify({
        text: summary,
        voiceId: "en-UK-theo",
      }),
    });

    functions.logger.info(`Murf.ai response status: ${response.status}`);
    functions.logger.info(
      `Murf.ai response content-type: ${response.headers.get("Content-Type")}`
    );

    if (!response.ok) {
      const errorText = await response.text();
      functions.logger.error("Murf stream failed:", response.status, errorText);
      return res
        .status(500)
        .json({ error: `Murf stream failed: ${errorText.substring(0, 200)}` });
    }

    // IMPORTANT: Verify Murf.ai's actual Content-Type. It might be audio/mp3, audio/wav, etc.
    // Use response.headers.get('Content-Type') to find the correct one.
    res.setHeader(
      "Content-Type",
      response.headers.get("Content-Type") || "audio/mpeg"
    );
    functions.logger.info("Piping Murf.ai audio stream to client.");
    response.body.pipe(res);
  } catch (err) {
    functions.logger.error("Error in summarizeTweet:", err);
    res.status(500).send(err.message || "Internal Server Error");
  }
});

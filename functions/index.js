import functions from "firebase-functions";
import admin from "firebase-admin";
import { TwitterApi } from "twitter-api-v2";
import OpenAI from 'openai'


admin.initializeApp();

const dbRef = admin.firestore().doc("tokens/demo");

import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const twitterClient = new TwitterApi({
  clientId: "VXBnNVpiYTNaZXByV3hucHRZeUw6MTpjaQ",
  clientSecret: "voxBC0E1nLJrIcjptMMh6n_owCQ8p_UZCYJglrvIMo7WcieLJl",
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
    const {codeVerifier, state: storedState} = dbSnapshot.data();

    if(state !== storedState) {
        res.status(400).send('Stored tokens do not match');
    }

    const {
        client: loggedClient,
        accessToken,
        refreshToken
    } = await twitterClient.loginWithOAuth2({
        code,
        codeVerifier,
        redirectUri: callbackUrl,
    })

    await dbRef.set({accessToken, refreshToken});

    res.send('Successfully logged in');
});

export const summarizeTweet = functions.https.onRequest(async (req, res) => {
  try {
    const tweetId = req.query.tweetId;
    if (!tweetId) {
      res.status(400).send("Missing tweetId");
      return;
    }

    const snapshot = await dbRef.get();
    const { accessToken, refreshToken } = snapshot.data();

    let client = new TwitterApi(accessToken);
    let tweet;

    try {
      tweet = await client.v2.singleTweet(tweetId);
    } catch (err) {
      console.log("Access token may have expired, refreshing...");
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
      tweet = await client.v2.singleTweet(tweetId);
    }

    const tweetText = tweet.data.text;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a helpful bot that summarizes the text written in a tweet.",
        },
        {
          role: "user",
          content: `Summarize this tweet: "${tweetText}"`,
        },
      ],
    });

    const summary = completion.choices[0].message.content;

    res.json({
      tweet: tweetText,
      summary: summary,
    });

  } catch (err) {
    console.error("Error in summarizeTweet:", err);
    res.status(500).send(err.message || "Internal Server Error");
  }
});


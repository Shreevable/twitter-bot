import {TwitterApi} from "twitter-api-v2";

export const twitterClient = process.env.TEST_MODE === "true" ?
  (await import("../test/mocks/twitter.js")).mockTwitterClient :
  new TwitterApi({
    appKey: process.env.API_KEY,
    appSecret: process.env.API_KEY_SECRET,
    accessToken: process.env.ACCESS_TOKEN,
    accessSecret: process.env.ACCESS_TOKEN_SECRET,
  });

export const REQUIRED_SCOPES = [
  "tweet.read", "tweet.write", "users.read", "offline.access",
];

export const WEBHOOK_ENV = process.env.NODE_ENV === "production" ?
  "prod" : "dev";

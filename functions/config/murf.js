export const LANGUAGE_MAP = {
  French: "fr_FR",
  German: "de_DE",
  Spanish: "es_ES",
  Hindi: "hi_IN",
  Japanese: "ja_JP",
  English: "en_US",
};

export const MURF_CONFIG = {
  apiKey: process.env.MURF_API_KEY,
  baseUrl: 'https://api.murf.ai/v1',
  maxRetries: 3,
  pollingInterval: 3000, // 3 seconds
  maxPollingTime: 360000, // 6 minutes
};

export const VOICE_MAP = {
  fr_FR: 'fr-FR-theo',
  de_DE: 'de-DE-marcus',
  es_ES: 'es-ES-maria',
  hi_IN: 'hi-IN-priya',
  ja_JP: 'ja-JP-hiro',
  en_US: 'en-US-marcus',
};

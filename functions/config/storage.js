import admin from 'firebase-admin';

export const bucket = admin.storage().bucket();

export const STORAGE_PATHS = {
  temp: 'temp',
  public: 'public',
};

export const FILE_TYPES = {
  VIDEO: 'video',
  AUDIO: 'audio',
};

export const getStoragePath = (userId, type, filename) => {
  return `${STORAGE_PATHS.temp}/${userId}/${type}/${filename}`;
};

export const getTempFileUrl = async (path, expirationMinutes = 60) => {
  const [url] = await bucket.file(path).getSignedUrl({
    action: 'read',
    expires: Date.now() + expirationMinutes * 60 * 1000,
  });
  return url;
};

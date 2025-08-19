import functions from "firebase-functions";

export class AppError extends Error {
  /**
   * @param {string} message The error message.
   * @param {string} code The error code.
   * @param {boolean} isOperational Whether the error is operational.
   */
  constructor(message, code, isOperational = true) {
    super(message);
    this.code = code;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorTypes = {
  TWITTER_API: "TWITTER_API_ERROR",
  MURF_API: "MURF_API_ERROR",
  VALIDATION: "VALIDATION_ERROR",
  STORAGE: "STORAGE_ERROR",
  UNKNOWN: "UNKNOWN_ERROR",
};

export const handleError = (error, context = {}) => {
  functions.logger.error("Error details:", {
    type: error.code || errorTypes.UNKNOWN,
    message: error.message,
    stack: error.stack,
    context,
  });

  // If error is not operational, we might want to notify developers
  if (!error.isOperational) {
    // TODO: Implement notification system (e.g., email, Slack)
    functions.logger.warn("Non-operational error occurred:", error);
  }

  return error;
};

export const retryOperation = async (
    operation,
    maxRetries = 3,
    delayMs = 1000,
) => {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry if it's a validation error or if we're out of retries
      if (error.code === errorTypes.VALIDATION || attempt === maxRetries) {
        throw error;
      }

      functions.logger.warn(`Attempt ${attempt} failed:`, error);

      // Exponential backoff
      const delay = delayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
};

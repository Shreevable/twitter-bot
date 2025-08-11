console.log("Content script loaded ✅");

function insertDubButton() {
  if (document.getElementById("dub-button")) return;

  const container = document.querySelector('article [role="group"]');

  if (container) {
    const btn = document.createElement("button");
    btn.id = "dub-button";
    btn.innerText = "🎙️ Dub Video";
    btn.style.padding = "6px 10px";
    btn.style.marginLeft = "10px";
    btn.style.background = "#1DA1F2";
    btn.style.color = "#fff";
    btn.style.border = "none";
    btn.style.borderRadius = "9999px";
    btn.style.cursor = "pointer";

    const langSelect = document.createElement("select");
    langSelect.id = "dub-language";
    langSelect.style.marginLeft = "10px";
    langSelect.style.padding = "6px";
    langSelect.style.borderRadius = "9999px";
    langSelect.style.border = "1px solid #1DA1F2";

    const languages = [
      { code: "hi", name: "Hindi" },
      { code: "es", name: "Spanish" },
      { code: "fr", name: "French" },
      { code: "de", name: "German" },
      { code: "ja", name: "Japanese" },
      { code: "ko", name: "Korean" },
      { code: "zh", name: "Chinese" }
    ];

    languages.forEach(lang => {
      const option = document.createElement("option");
      option.value = lang.code;
      option.text = lang.name;
      langSelect.appendChild(option);
    });

    btn.addEventListener("click", handleDub);

    container.appendChild(btn);
    container.appendChild(langSelect);
  }
}

async function handleDub() {
  let controller;
  let timeoutId;
  let isCancelled = false;
  const dubButton = document.getElementById("dub-button");
  const originalButtonText = dubButton.innerText;

  // Function to clean up resources
  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId);
    if (controller) controller.abort();
    dubButton.innerText = originalButtonText;
    dubButton.disabled = false;
    const backdrop = document.getElementById("message-box-backdrop");
    if (backdrop) backdrop.remove();
  };

  try {
    // Validate tweet URL
    const tweetUrl = window.location.href;
    const tweetIdMatch = tweetUrl.match(/status\/(\d+)/);
    if (!tweetIdMatch) {
      showMessageBox(DubbingState.ERROR, "Could not detect Tweet ID.");
      return;
    }

    const tweetId = tweetIdMatch[1];
    const targetLanguage = document.getElementById("dub-language").value;
    console.log("Tweet ID:", tweetId, "Target Language:", targetLanguage);

    // Update UI
    dubButton.innerText = "🎙️ Dubbing...";
    dubButton.disabled = true;

    // Show initial progress
    showMessageBox("Processing", DubbingState.DOWNLOADING, true);
    
    // Setup request with timeout
    controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 360000); // 6 minutes

    // Prepare request URL
    // Use localhost for development, production URL would be different
    const apiUrl = new URL('http://localhost:5001/project-4261681351/us-central1/dubVideo');
    apiUrl.searchParams.append('tweetUrl', tweetUrl);
    apiUrl.searchParams.append('targetLanguage', targetLanguage);

    // Store the current operation for cancellation
    window.currentDubOperation = {
      cancel: () => {
        isCancelled = true;
        cleanup();
        showMessageBox(DubbingState.ERROR, "Operation cancelled by user");
      }
    };

    // Make request
    const response = await fetch(apiUrl.toString(), {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'Origin': window.location.origin
      },
      cache: 'no-store'
    });

    // Check if cancelled
    if (isCancelled) {
      return;
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error("Server error:", {
        status: response.status,
        statusText: response.statusText,
        error: errText
      });

      let errorMessage = "Unknown error occurred";
      if (response.status === 404) {
        errorMessage = "Video not found. Make sure the tweet contains a video.";
      } else if (response.status === 429) {
        errorMessage = "Rate limit exceeded. Please try again in a few minutes.";
      } else if (response.status === 500) {
        try {
          const errJson = JSON.parse(errText);
          if (errJson.error?.includes("Failed to download")) {
            errorMessage = "Could not download video. The tweet might be private or deleted.";
          } else if (errJson.error?.includes("Murf")) {
            errorMessage = "Error during dubbing process. Please try again.";
          } else if (errJson.error?.includes("language")) {
            errorMessage = "Selected language is not supported.";
          } else {
            errorMessage = errJson.error || `Server error: ${errText.substring(0, 100)}`;
          }
        } catch {
          errorMessage = `Server error (${response.status}): ${errText.substring(0, 100)}`;
        }
      }

      showMessageBox(DubbingState.ERROR, errorMessage);
      return;
    }

    try {
      // Backend replies with JSON { success, language, dubbedVideoUrl }
      const data = await response.json();
      if (!data?.dubbedVideoUrl) {
        throw new Error("Invalid response: missing dubbed video URL");
      }

      // Show processing state while Murf works
      showMessageBox("Processing", DubbingState.PROCESSING, true);

      // Poll Murf job status (data.jobId) if available
      if (data.jobId) {
        let attempts = 0;
        const maxAttempts = 120; // 6 minutes
        while (attempts < maxAttempts) {
          attempts++;
          showMessageBox(
            "Processing",
            `${DubbingState.PROCESSING} (${attempts}/${maxAttempts})`,
            true
          );
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      // Show completion and open video
      showMessageBox("Success", DubbingState.COMPLETED, true);
      window.open(data.dubbedVideoUrl, "_blank");
      console.log("Dubbed video ready:", data.dubbedVideoUrl);

      // Auto-close success message after 2 seconds
      setTimeout(() => {
        const box = document.getElementById("custom-message-box");
        if (box) box.style.display = "none";
      }, 2000);

    } catch (parseError) {
      console.error("Response parsing failed:", parseError);
      showMessageBox(DubbingState.ERROR, "Invalid response from server");
    }
  } catch (err) {
    console.error("Client error:", err);
    let errorMessage = "Network error. Please check your connection.";
    
    if (err.name === "AbortError") {
      errorMessage = "Request timed out after 6 minutes. The video might be too long or the server is busy.";
    } else if (err.message === "Failed to fetch") {
      errorMessage = "Server connection failed. Please try again in a few minutes.";
    } else if (err.name === "TypeError") {
      errorMessage = "Network error. The server might be down or restarting.";
    }
    
    showMessageBox(DubbingState.ERROR, errorMessage);
  } finally {
    clearTimeout(timeoutId); // Clear timeout to prevent memory leaks
    dubButton.innerText = originalButtonText;
    dubButton.disabled = false;
  }
}

// Custom Message Box Function (replaces alert())
// Progress states for the dubbing process
const DubbingState = {
  DOWNLOADING: 'Downloading video...',
  PROCESSING: 'Processing with Murf AI...',
  COMPLETED: 'Opening dubbed video...',
  ERROR: 'Error'
};

function showMessageBox(title, message, isProgress = false) {
  // Remove existing message box if any
  const existingBox = document.getElementById("custom-message-box");
  if (existingBox) {
    existingBox.remove();
  }

  // Create backdrop for modal
  const backdrop = document.createElement("div");
  backdrop.id = "message-box-backdrop";
  backdrop.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.2s ease-out;
  `;
  document.body.appendChild(backdrop);

  const messageBox = document.createElement("div");
  messageBox.id = "custom-message-box";
  messageBox.setAttribute("role", "dialog");
  messageBox.setAttribute("aria-labelledby", "message-title");
  messageBox.setAttribute("aria-describedby", "message-content");
  
  // Add styles to head if not already present
  if (!document.getElementById('message-box-styles')) {
    const styleSheet = document.createElement('style');
    styleSheet.id = 'message-box-styles';
    styleSheet.textContent = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .progress-spinner {
        border: 3px solid #f3f3f3;
        border-top: 3px solid #1DA1F2;
        border-radius: 50%;
        width: 24px;
        height: 24px;
        animation: spin 1s linear infinite;
        margin: 15px auto;
      }
      .message-box {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background-color: white;
        border: 1px solid #ccc;
        box-shadow: 0 8px 16px rgba(0,0,0,0.2);
        padding: 20px;
        z-index: 10000;
        border-radius: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        min-width: 300px;
        max-width: 400px;
        text-align: center;
        animation: fadeIn 0.3s ease-out;
      }
      .message-title {
        margin: 0 0 10px 0;
        font-size: 18px;
        font-weight: 600;
      }
      .message-content {
        margin: 10px 0;
        color: #536471;
        font-size: 15px;
        line-height: 1.4;
      }
      .message-button {
        background-color: #1DA1F2;
        color: white;
        border: none;
        padding: 8px 20px;
        border-radius: 9999px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
        margin-top: 15px;
        transition: background-color 0.2s;
      }
      .message-button:hover {
        background-color: #1a8cd8;
      }
      .message-button-secondary {
        background-color: transparent;
        color: #536471;
        border: 1px solid #536471;
        margin-left: 10px;
      }
      .message-button-secondary:hover {
        background-color: rgba(83, 100, 113, 0.1);
      }
      .message-progress {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        margin: 15px 0;
      }
      .message-progress-text {
        color: #536471;
        font-size: 14px;
      }
      @keyframes slideIn {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      .message-box {
        animation: slideIn 0.3s ease-out;
      }
    `;
    document.head.appendChild(styleSheet);
  }

  messageBox.className = 'message-box';

  // Add progress spinner for non-error states
  const spinnerHtml = isProgress ? `
    <div class="progress-spinner" style="
      border: 3px solid #f3f3f3;
      border-top: 3px solid #1DA1F2;
      border-radius: 50%;
      width: 20px;
      height: 20px;
      animation: spin 1s linear infinite;
      margin: 10px auto;
    "></div>
    <style>
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    </style>
  ` : '';

  messageBox.innerHTML = `
    <h4 id="message-title" class="message-title" style="color: ${
      title === DubbingState.ERROR ? "#E0245E" : "#1DA1F2"
    };">${title}</h4>
    ${isProgress ? `
      <div class="progress-spinner"></div>
      <button id="message-box-cancel" class="message-button message-button-secondary">
        Cancel
      </button>
    ` : ''}
    <p id="message-content" class="message-content">${message}</p>
    ${!isProgress ? '<button id="message-box-ok" class="message-button">OK</button>' : ''}
  `;

  // Add click handlers for buttons
  const okButton = messageBox.querySelector('#message-box-ok');
  const cancelButton = messageBox.querySelector('#message-box-cancel');

  if (okButton) {
    okButton.onclick = () => {
      const backdrop = document.getElementById("message-box-backdrop");
      if (backdrop) backdrop.remove();
    };
  }

  if (cancelButton) {
    cancelButton.onclick = () => {
      if (typeof window.currentDubOperation?.cancel === 'function') {
        window.currentDubOperation.cancel();
      }
      const backdrop = document.getElementById("message-box-backdrop");
      if (backdrop) backdrop.remove();
    };
  }

  // Add to document
  backdrop.appendChild(messageBox);

  // Return the message box element so it can be updated/removed later
  return messageBox;
}

// Wait for tweet page to load fully
setInterval(insertDubButton, 2000);

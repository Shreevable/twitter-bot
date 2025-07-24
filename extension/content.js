console.log("Content script loaded ✅");

function insertSummarizeButton() {
  if (document.getElementById("summarize-button")) return;

  const container = document.querySelector('article [role="group"]');

  if (container) {
    const btn = document.createElement("button");
    btn.id = "summarize-button";
    btn.innerText = "🔊 Summarize";
    btn.style.padding = "6px 10px";
    btn.style.marginLeft = "10px";
    btn.style.background = "#1DA1F2";
    btn.style.color = "#fff";
    btn.style.border = "none";
    btn.style.borderRadius = "9999px";
    btn.style.cursor = "pointer";

    btn.addEventListener("click", handleSummarize);

    container.appendChild(btn);
  }
}

async function handleSummarize() {
  const tweetUrl = window.location.href;
  const tweetIdMatch = tweetUrl.match(/status\/(\d+)/);
  if (!tweetIdMatch) {
    // Using a custom message box instead of alert() as per instructions
    showMessageBox("Error", "Could not detect Tweet ID.");
    return;
  }

  const tweetId = tweetIdMatch[1];
  console.log("Tweet ID:", tweetId); // Add a loading indicator

  const summarizeButton = document.getElementById("summarize-button");
  const originalButtonText = summarizeButton.innerText;
  summarizeButton.innerText = "🔊 Summarizing...";
  summarizeButton.disabled = true; // Disable button during processing

  try {
    const response = await fetch(
      `http://localhost:5000/project-4261681351/us-central1/summarizeTweet?tweetId=${tweetId}`
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("Server error:", errText); // Using a custom message box instead of alert()
      showMessageBox(
        "Error",
        `Error summarizing tweet: ${errText.substring(0, 100)}`
      );
      return;
    }

    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);

    const audio = new Audio(audioUrl);

    // Wait for the audio to be ready to play
    await new Promise((resolve, reject) => {
      audio.addEventListener(
        "canplaythrough",
        () => {
          console.log("Audio is ready to play.");
          resolve();
        },
        { once: true }
      );
      audio.addEventListener(
        "error",
        (e) => {
          console.error("Audio playback error:", e);
          reject(new Error("Audio playback failed."));
        },
        { once: true }
      );
      // Set a timeout in case canplaythrough never fires (e.g., corrupted audio)
      setTimeout(() => reject(new Error("Audio loading timed out.")), 10000); // 10 seconds timeout
    });

    audio.play();
    console.log("Playing summary audio...");
  } catch (err) {
    console.error(err); // Using a custom message box instead of alert()
    showMessageBox("Error", `Failed to summarize tweet: ${err.message || err}`);
  } finally {
    // Reset button state
    summarizeButton.innerText = originalButtonText;
    summarizeButton.disabled = false;
  }
}

// Custom Message Box Function (replaces alert())
function showMessageBox(title, message) {
  let messageBox = document.getElementById("custom-message-box");
  if (!messageBox) {
    messageBox = document.createElement("div");
    messageBox.id = "custom-message-box";
    messageBox.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background-color: white;
            border: 1px solid #ccc;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            padding: 20px;
            z-index: 10000;
            border-radius: 8px;
            font-family: Arial, sans-serif;
            max-width: 300px;
            text-align: center;
        `;
    document.body.appendChild(messageBox);
  }

  messageBox.innerHTML = `
        <h4 style="margin-top: 0; color: ${
          title === "Error" ? "red" : "black"
        };">${title}</h4>
        <p>${message}</p>
        <button id="message-box-ok" style="
            background-color: #1DA1F2;
            color: white;
            border: none;
            padding: 8px 15px;
            border-radius: 5px;
            cursor: pointer;
            margin-top: 10px;
        ">OK</button>
    `;
  messageBox.style.display = "block";

  document.getElementById("message-box-ok").onclick = () => {
    messageBox.style.display = "none";
  };
}

// Wait for tweet page to load fully
setInterval(insertSummarizeButton, 2000);

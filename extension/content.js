console.log("Content script loaded");

// 1️⃣ Observe tweets being added to the page
const observer = new MutationObserver(() => {
  addSummarizeButtons();
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

// 2️⃣ Function to find tweets & add buttons
function addSummarizeButtons() {
  const tweets = document.querySelectorAll('article[data-testid="tweet"]');

  tweets.forEach((tweet) => {
    if (tweet.querySelector(".summarize-button")) return; // already added

    const btn = document.createElement("button");
    btn.innerText = "🔍 Summarize";
    btn.className = "summarize-button";
    btn.style.margin = "8px";
    btn.style.padding = "4px 8px";
    btn.style.background = "#1DA1F2";
    btn.style.color = "#fff";
    btn.style.border = "none";
    btn.style.borderRadius = "4px";
    btn.style.cursor = "pointer";

    btn.addEventListener("click", () => {
      const tweetId = getTweetId(tweet);
      if (tweetId) {
        summarize(tweetId, btn);
      } else {
        alert("Could not find tweet ID");
      }
    });

    // Find a place to insert the button (bottom of tweet)
    const footer = tweet.querySelector('[role="group"]');
    if (footer) {
      footer.appendChild(btn);
    }
  });
}

// 3️⃣ Extract tweet ID
function getTweetId(tweet) {
  const anchor = tweet.querySelector('a[href*="/status/"]');
  if (anchor) {
    const match = anchor.href.match(/status\/(\d+)/);
    return match ? match[1] : null;
  }
  return null;
}

// 4️⃣ Call your Firebase backend
async function summarize(tweetId, btn) {
  btn.innerText = "⏳ Summarizing...";
  try {
    const response = await fetch(
      `http://localhost:5000/project-4261681351/us-central1/summarizeTweet?tweetId=${tweetId}`
    );
    const data = await response.json();
    console.log("Summary:", data);

    alert(`Summary:\n${data.summary}`);
    btn.innerText = "✅ Summarized!";
  } catch (err) {
    console.error(err);
    alert("Error summarizing");
    btn.innerText = "❌ Failed";
  }
}

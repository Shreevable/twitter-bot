document.getElementById("auth").addEventListener("click", () => {
    chrome.tabs.create({
      url: "http://localhost:5000/project-4261681351/us-central1/auth",
    });
  });
  
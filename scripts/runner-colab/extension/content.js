(() => {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (
    new URLSearchParams(location.search).get("gitedge-waker") !== "1" ||
    !hash.get("mcpProxyToken") ||
    !/^\d{1,5}$/.test(hash.get("mcpProxyPort") ?? "")
  )
    return;
  const deadline = Date.now() + 90_000;
  const timer = setInterval(() => {
    const button = document.querySelector(
      'md-dialog.local-mcp-connect-dialog[open] md-filled-button[value="ok"]'
    );
    if (button) {
      clearInterval(timer);
      button.click();
    } else if (Date.now() > deadline) clearInterval(timer);
  }, 500);
})();

const channelName = "gitedge-browser-identity";

export function notifyBrowserIdentityChanged(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(channelName);
  channel.postMessage({ type: "identity-changed" });
  channel.close();
}

export function listenForBrowserIdentityChanges(onChange: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (
      typeof event.data === "object" &&
      event.data !== null &&
      "type" in event.data &&
      event.data.type === "identity-changed"
    )
      onChange();
  };
  return () => channel.close();
}

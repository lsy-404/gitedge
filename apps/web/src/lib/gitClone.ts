export function gatewayCloneUrl(origin: string, owner: string, repository: string): string {
  return new URL(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}.git`,
    origin
  ).toString();
}

export function authenticatedCloneCommand(remote: string, token: string): string {
  return `git -c http.extraHeader="Authorization: Bearer ${token}" clone ${remote}`;
}

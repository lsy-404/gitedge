export function gatewayCloneUrl(origin: string, owner: string, repository: string): string {
  return new URL(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}.git`,
    origin
  ).toString();
}

function shellArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function cloneCommand(remote: string, branch: string, token?: string): string {
  const authorization = token
    ? ` -c ${shellArgument(`http.extraHeader=Authorization: Bearer ${token}`)}`
    : "";
  return `git${authorization} clone --branch ${shellArgument(branch)} -- ${shellArgument(remote)}`;
}

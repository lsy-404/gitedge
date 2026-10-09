export function gatewayCloneUrl(origin: string, owner: string, repository: string): string {
  return new URL(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}.git`,
    origin
  ).toString();
}

function shellArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@%-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function cloneCommand(remote: string): string {
  return `git clone ${shellArgument(remote)}`;
}

export function newRepositoryCommands(remote: string, name: string, branch: string): string {
  return [
    `mkdir ${shellArgument(name)} && cd ${shellArgument(name)}`,
    "git init",
    `echo ${shellArgument(`# ${name}`)} > README.md`,
    'git add README.md && git commit -m "first commit"',
    `git branch -M ${shellArgument(branch)}`,
    `git remote add origin ${shellArgument(remote)}`,
    `git push -u origin ${shellArgument(branch)}`,
  ].join("\n");
}

export function existingRepositoryCommands(remote: string): string {
  return [
    `git remote add gitedge ${shellArgument(remote)}`,
    "git push gitedge --all",
    "git push gitedge --tags",
  ].join("\n");
}

export interface CredentialHelperHint {
  id: "osxkeychain" | "manager" | "libsecret" | "store";
  command: string;
  plaintext: boolean;
}

export const credentialHelperHints: readonly CredentialHelperHint[] = [
  {
    id: "osxkeychain",
    command: "git config --global credential.helper osxkeychain",
    plaintext: false,
  },
  { id: "manager", command: "git config --global credential.helper manager", plaintext: false },
  { id: "libsecret", command: "git config --global credential.helper libsecret", plaintext: false },
  { id: "store", command: "git config --global credential.helper store", plaintext: true },
];

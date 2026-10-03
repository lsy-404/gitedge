import type { RepositoryCommunityFile } from "./api";

export function communitySourceUrl(file: RepositoryCommunityFile, refName: string): string {
  const path = file.path.split("/").map(encodeURIComponent).join("/");
  const source = `/${encodeURIComponent(file.owner)}/${encodeURIComponent(file.repository)}/blob/${path}`;
  return file.inherited ? source : `${source}?ref=${encodeURIComponent(refName)}`;
}

export function isCommunityTruncated(value: object): boolean {
  return "truncated" in value && value.truncated === true;
}

import type { RepositoryCommunityFile } from "./api";

export function communitySourceUrl(file: RepositoryCommunityFile): string {
  const path = file.path.split("/").map(encodeURIComponent).join("/");
  const source = `/${encodeURIComponent(file.owner)}/${encodeURIComponent(file.repository)}/blob/${path}`;
  return `${source}?ref=${encodeURIComponent(file.ref)}`;
}

export function isCommunityTruncated(value: object): boolean {
  return "truncated" in value && value.truncated === true;
}

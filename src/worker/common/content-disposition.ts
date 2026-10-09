/** Builds a Content-Disposition value that keeps non-ASCII names intact and cannot break out of the header. */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const clean = filename.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) || "download";
  const fallback = clean.replace(/[^\x20-\x7e]|["\\%;]/g, "_");
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

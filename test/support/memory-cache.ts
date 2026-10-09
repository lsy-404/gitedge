/** Minimal Cache API stand-in that keeps responses by URL for unit tests. */
export class MemoryCache implements Cache {
  readonly entries = new Map<string, Response>();
  reads = 0;
  writes = 0;

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    this.reads += 1;
    return this.entries.get(new Request(request).url)?.clone();
  }
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.writes += 1;
    this.entries.set(new Request(request).url, response.clone());
  }
  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(new Request(request).url);
  }
  async add(): Promise<void> {
    throw new Error("Not supported.");
  }
  async addAll(): Promise<void> {
    throw new Error("Not supported.");
  }
  async keys(): Promise<readonly Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

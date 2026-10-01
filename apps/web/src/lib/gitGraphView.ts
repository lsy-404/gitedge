import type { AgentSession, GitCommit, GitGraph } from "../../../../packages/contracts/src/forge";

export interface GraphSessionMarker {
  session: AgentSession;
  kind: "base" | "fork";
  oid: string;
  branchName: string | null;
}

export interface GitGraphView {
  refsByOid: Map<string, string[]>;
  sessionsByOid: Map<string, GraphSessionMarker[]>;
  sessionForkRefCount: number;
  sessionsWithForkRefs: number;
  sessionsWithoutForkRefs: number;
  visibleSessionCount: number;
}

export function projectGitGraph(graph: GitGraph): GitGraphView {
  const refsByOid = new Map<string, string[]>();
  const sessionsByOid = new Map<string, GraphSessionMarker[]>();
  const sessionsById = new Map(graph.sessions.map((session) => [session.id, session]));
  const forkSessionIds = new Set<string>();
  let sessionForkRefCount = 0;

  function addRef(oid: string, label: string): void {
    const labels = refsByOid.get(oid) ?? [];
    labels.push(label);
    refsByOid.set(oid, labels);
  }

  function addSessionMarker(marker: GraphSessionMarker): void {
    const markers = sessionsByOid.get(marker.oid) ?? [];
    markers.push(marker);
    sessionsByOid.set(marker.oid, markers);
  }

  for (const session of graph.sessions) {
    if (session.baseOid) {
      addSessionMarker({ session, kind: "base", oid: session.baseOid, branchName: null });
    }
  }

  for (const ref of graph.refs) {
    if (!ref.name.startsWith("session/")) {
      addRef(ref.oid, ref.name.replace(/^refs\/(heads|tags)\//, ""));
      continue;
    }

    sessionForkRefCount += 1;
    const [, sessionId, ...branchParts] = ref.name.split("/");
    const session = sessionsById.get(sessionId ?? "");
    const branchName = branchParts.join("/") || null;
    const label = session && branchName ? `${session.workspaceName}:${branchName}` : ref.name;
    addRef(ref.oid, label);
    if (session) {
      forkSessionIds.add(session.id);
      addSessionMarker({ session, kind: "fork", oid: ref.oid, branchName });
    }
  }

  const visibleSessionCount = graph.sessions.filter(
    (session) => session.status !== "revoked"
  ).length;
  return {
    refsByOid,
    sessionsByOid,
    sessionForkRefCount,
    sessionsWithForkRefs: forkSessionIds.size,
    sessionsWithoutForkRefs: Math.max(0, visibleSessionCount - forkSessionIds.size),
    visibleSessionCount,
  };
}

export function findGraphCommit(
  oid: string,
  graph: GitGraph | null,
  pageCommits: GitCommit[]
): GitCommit | undefined {
  return (
    graph?.commits.find((commit) => commit.oid === oid) ??
    pageCommits.find((commit) => commit.oid === oid)
  );
}

export function agentSessionDisplayStatus(
  session: AgentSession,
  now: number
): AgentSession["status"] | "expired" {
  return session.status === "active" && session.expiresAt <= now ? "expired" : session.status;
}

export function repositoryCodeLocation(
  owner: string,
  repository: string,
  view: "tree" | "blob",
  path: string,
  ref: string
): { path: string; query: { ref: string } } {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return {
    path: `/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${view}/${encodedPath}`,
    query: { ref },
  };
}

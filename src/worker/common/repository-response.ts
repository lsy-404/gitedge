import { REPOSITORY_ACCESS_DENIED_HEADER } from "../../../packages/contracts/src/trust";

export function repositoryNotFound(): Response {
  return Response.json(
    { error: { code: "not_found", message: "Repository was not found." } },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

export function repositoryAccessDenied(): Response {
  const response = repositoryNotFound();
  response.headers.set(REPOSITORY_ACCESS_DENIED_HEADER, "1");
  return response;
}

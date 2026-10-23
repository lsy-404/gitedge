# Findings

- Forge filters public profiles to public, non-system, non-deleted repositories. Disabled or deleted personal identities return not found.
- Repository star/fork counts, topics and timestamps are service-owned; popular repositories sort by stars and recent update time instead of claiming manual pins.
- Account and collaboration timestamps use Unix epoch milliseconds. `users.created_at` and profile activity timestamps pass through unchanged; the client formats them as milliseconds.
- Existing `repository_stars` storage supports a bounded public starred-repository list. Private and system repositories are filtered before returning results.
- Recent activity is a bounded union of human-authored public issue, pull request and comment records; private, deleted and system repositories and non-human actor records are omitted. Comments must match an existing issue, pull request or discussion in the same repository.
- Public response uses the canonical profile contract and omits the internal user id used for scoped D1 lookups.
- The existing app avatar menu already links to the signed-in user's profile; the profile page also links owners to account profile settings.
- Cloudflare D1 prepared statement guidance and Workers best practices were checked from official docs.

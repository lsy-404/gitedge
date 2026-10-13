/** Empty D1 fixture for Gateway tests that do not exercise stored access policy. */
export function emptyGatewayDatabase(): D1Database {
  const statement = {
    bind: () => statement,
    first: async () => null,
    all: async () => ({ results: [] }),
  };
  return { prepare: () => statement } as unknown as D1Database;
}

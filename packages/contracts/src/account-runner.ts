import { z } from "zod";
import { RepositorySchema } from "./forge";

export const AccountRunnerStateSchema = z.object({
  repository: RepositorySchema.nullable(),
});
export type AccountRunnerState = z.infer<typeof AccountRunnerStateSchema>;
export const AccountRunnerProvisionResponseSchema = RepositorySchema;
export type AccountRunnerProvisionResponse = z.infer<typeof AccountRunnerProvisionResponseSchema>;

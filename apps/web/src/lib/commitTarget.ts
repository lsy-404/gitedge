import { computed, ref, type ComputedRef, type Ref } from "vue";
import { GitBranchSchema } from "../../../../packages/contracts/src/index";
import type { RepositoryBranch } from "./api";

export interface CommitTarget {
  message: Ref<string>;
  newBranch: Ref<string>;
  createPull: Ref<boolean>;
  protectedRejected: Ref<boolean>;
  protectedBranch: ComputedRef<boolean>;
  targetBranch: ComputedRef<string>;
  targetBranchValid: ComputedRef<boolean>;
  reset: () => void;
}

/** Shared commit message and destination-branch state for every web write flow. */
export function useCommitTarget(
  branches: () => RepositoryBranch[],
  branchInfo: () => RepositoryBranch | null
): CommitTarget {
  const message = ref("");
  const newBranch = ref("");
  const createPull = ref(false);
  const protectedRejected = ref(false);
  const protectedBranch = computed(() =>
    Boolean(branchInfo()?.protected || protectedRejected.value)
  );
  const targetBranch = computed(() => newBranch.value.trim());
  const targetBranchValid = computed(() => {
    if (!targetBranch.value) return !protectedBranch.value;
    return (
      GitBranchSchema.safeParse(targetBranch.value).success &&
      !branches().some((branch) => branch.name === targetBranch.value)
    );
  });
  function reset() {
    message.value = "";
    newBranch.value = "";
    createPull.value = false;
    protectedRejected.value = false;
  }
  return {
    message,
    newBranch,
    createPull,
    protectedRejected,
    protectedBranch,
    targetBranch,
    targetBranchValid,
    reset,
  };
}

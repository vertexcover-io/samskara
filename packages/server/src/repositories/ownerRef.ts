/**
 * Who owns a row: an org or a user, never both and never neither. `projects` and `repos` both carry
 * this shape, and a repo takes its owner from the project its session belongs to, so the two have
 * to agree on what an owner is.
 */
export type OwnerRef =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "org"; readonly orgId: string }

/** The owner column to write. The conflict target stays per-table, since each names its own
 * partial-unique index. */
export const ownerColumns = (
  owner: OwnerRef,
): { readonly ownerUserId: string } | { readonly ownerOrgId: string } =>
  owner.kind === "user" ? { ownerUserId: owner.userId } : { ownerOrgId: owner.orgId }

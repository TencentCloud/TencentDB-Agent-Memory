/**
 * Query endpoints use a resolved isolation context, where omitted fields are
 * represented by the legacy default bucket. That default is valid for writes,
 * but must not silently narrow an aggregate read.
 */
export function optionalQueryUserId(
  body: Record<string, unknown> | undefined,
  resolvedUserId: string | undefined,
): string | undefined {
  const requested = body?.user_id;
  return typeof requested === 'string' && requested.trim() ? resolvedUserId : undefined;
}
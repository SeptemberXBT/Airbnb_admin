export const DEFAULT_GUEST_SUPPORT_EMAIL = "hello@noirhaus.in";

export function resolveGuestSupportEmail(
  environment: { GUEST_SUPPORT_EMAIL?: string } = process.env,
) {
  return environment.GUEST_SUPPORT_EMAIL?.trim() || DEFAULT_GUEST_SUPPORT_EMAIL;
}

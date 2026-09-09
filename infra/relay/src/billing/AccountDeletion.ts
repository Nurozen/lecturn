import { verifyWebhook } from "@clerk/backend/webhooks";

/** Dedicated Clerk endpoint: never reuse the authentication-email signing secret. */
export async function verifyAccountDeletion(request: Request, signingSecret: string) {
  if (!signingSecret) throw new Error("Clerk account deletion signing secret is not configured");
  const event = await verifyWebhook(request, { signingSecret });
  if (event.type !== "user.deleted") return null;
  if (!event.data.id) throw new Error("Deleted Clerk user has no identity");
  const eventId = request.headers.get("svix-id");
  if (!eventId) throw new Error("Missing Clerk event identity");
  return { userId: event.data.id, eventId: `clerk:${eventId}` };
}

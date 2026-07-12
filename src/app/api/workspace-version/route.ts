import { getWorkspaceVersion } from "@/features/workspace/workspace-version-service";
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const user = await requireUser();
    const version = await getWorkspaceVersion(user.id);
    return NextResponse.json({ version }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "operation_failed" }, { status: 500 });
  }
}

import { PricingManager } from "@/features/pricing/pricing-manager";
import { listPricingForUser } from "@/features/pricing/pricing-service";
import { requireUser } from "@/lib/auth/require-user";
import { sharedWorkspaceVersion } from "@/lib/shared-workspace-version";

export default async function PricingPage() {
  const user = await requireUser();
  const demoMode = process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production";
  const pricing = await listPricingForUser(user.id);
  return (
    <div className="workspace workspace--pricing">
      <header className="page-header">
        <div><p className="eyebrow">Website booking controls</p><h1>Pricing</h1></div>
        <p className="page-header__note">Friday and Saturday use weekend rates. A custom date price takes priority.</p>
      </header>
      <PricingManager key={sharedWorkspaceVersion(pricing)} initialPricing={pricing} demoMode={demoMode} />
    </div>
  );
}

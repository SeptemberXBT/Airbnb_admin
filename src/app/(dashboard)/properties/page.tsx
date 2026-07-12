import { PropertyManager } from "@/features/properties/property-manager";
import { listPropertiesForUser } from "@/features/properties/property-service";
import { requireUser } from "@/lib/auth/require-user";

export default async function PropertiesPage() {
  const user = await requireUser();
  const demoMode = process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production";
  const properties = await listPropertiesForUser(user.id);
  return (
    <div className="workspace">
      <header className="page-header"><div><p className="eyebrow">Portfolio setup</p><h1>Properties</h1></div></header>
      <PropertyManager initialProperties={properties} demoMode={demoMode} />
    </div>
  );
}

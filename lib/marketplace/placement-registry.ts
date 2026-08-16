import { MemoryPlacementDeliveryRepository } from "./placement-delivery.ts";
import { D1PlacementDeliveryRepository } from "./d1-placement.ts";

export const placementDeliveryRepository = new MemoryPlacementDeliveryRepository();

let deployed: D1PlacementDeliveryRepository | undefined;
export async function getPlacementDeliveryRepository() {
  if (deployed) return deployed;
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 placement binding is required");
  deployed = new D1PlacementDeliveryRepository(env.DB);
  return deployed;
}

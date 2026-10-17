// Where each vendor stands: the server's lifecycle when signed in, the demo's own record otherwise.
// Both are keyed by `vendorKey(vendor)` (the uuid for a live vendor, the business number for a demo one)
// and have the same shape, so the board draws either.

import { useStore } from './useStore'
import { useProto } from './useProto'
import { vendorKey } from '../lib/vendors'

export function useVendorStages() {
  const live = useStore((s) => s.hydrated)
  const server = useStore((s) => s.vendorLifecycle)
  const demo = useProto((s) => s.vendorStages)
  return live ? server : demo
}

export const useVendorEntry = (vendor) => useVendorStages()?.[vendorKey(vendor)]

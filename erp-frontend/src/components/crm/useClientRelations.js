import { useEffect } from 'react'
import { useProto, EMPTY_RELATION } from '../../store/useProto'
import { useStore } from '../../store/useStore'
import { useRelations } from '../../store/useRelations'

/**
 * A client's relationships, from wherever they live: the proto store in the offline demo, the server
 * when signed in (`live`). Either way the caller gets the same `r` (people, cycles, anniversary,
 * handled nudges) and `greetings` (what has been sent), so the panels draw one shape.
 */
export function useClientRelations(client) {
  const live = useStore((s) => s.hydrated)
  const demoRelation = useProto((s) => s.relations[client.id])
  const demoLog = useProto((s) => s.greetingLog)
  const served = useRelations((s) => s.byClient[client.uuid])

  useEffect(() => {
    if (live && client.uuid) useRelations.getState().loadClient(client.uuid)
  }, [live, client.uuid])

  if (!live) {
    return {
      live: false,
      r: { ...EMPTY_RELATION, ...demoRelation },
      greetings: demoLog.filter((l) => l.clientId === client.id),
    }
  }
  const r = served || { ...EMPTY_RELATION, greetings: [] }
  return {
    live: true,
    r,
    greetings: (r.greetings || []).map((g) => ({
      id: g.id, at: g.at, clientId: client.id, kind: g.kind, to: g.to, channel: g.channel,
    })),
  }
}

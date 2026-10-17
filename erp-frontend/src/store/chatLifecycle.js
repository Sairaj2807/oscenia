// Starts live chat when a real person signs in, and stops it (closing the socket, forgetting the
// data) when they sign out or switch to another account.
//
// A separate, tiny module so the store does not need to know about auth, and auth does not need
// to know about chat. Called once from `main.jsx`.

import { useAuth } from './useAuth.js'
import { useChat } from './useChat.js'
import { useNotifications } from './useNotifications.js'
import { useEvents } from './useEvents.js'
import { canSee } from '../lib/roles.js'
import { useTasks } from './useTasks.js'
import { onFrame, setTaskIdsProvider } from './chatFrames.js'
import { isLiveUser } from './chatProto.js'

let started = false

export function startChatLifecycle() {
  if (started) return
  started = true

  const follow = (user) => {
    if (isLiveUser(user)) {
      useChat.getState().start()
      useNotifications.getState().start(user.id) // the bell's events and CRM items; no persona needed
      // Events are for the roles that may see the module; Finance and Warehouse would only get a 403.
      if (canSee(user.role, 'events')) useEvents.getState().start(user.id)
    } else {
      useChat.getState().stop()
      useNotifications.getState().stop()
      useEvents.getState().stop()
    }
  }

  // A different person (or none) means different data: always a clean stop, then a start.
  useAuth.subscribe((state, prev) => {
    if (state.user?.id !== prev.user?.id || isLiveUser(state.user) !== isLiveUser(prev.user)) {
      useChat.getState().stop()
      useNotifications.getState().stop()
      useEvents.getState().stop()
      follow(state.user)
    }
  })
  follow(useAuth.getState().user)

  // Tasks follow chat's workspace: they load once it is ready (it knows who everyone is), load
  // again after a dropped connection comes back (changes may have been missed), and clear when it
  // is stopped. `task.*` frames arrive through the same socket.
  useChat.subscribe((state, prev) => {
    if (state.status === 'ready' && prev.status !== 'ready') useTasks.getState().load()
    else if (state.status !== 'ready' && prev.status === 'ready') useTasks.getState().reset()
    else if (state.status === 'ready' && state.connection === 'open' && prev.connection === 'reconnecting') useTasks.getState().load()
  })
  setTaskIdsProvider(() => useTasks.getState().tasks.map((t) => t.id))
  onFrame((frame) => {
    if (typeof frame?.type === 'string' && frame.type.startsWith('task.')) useTasks.getState().receive(frame)
    if (frame?.type === 'tasks.refresh') useTasks.getState().load()
  })
}

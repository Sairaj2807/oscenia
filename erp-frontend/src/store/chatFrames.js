// A tiny bus for server frames, so the stores that need to hear one (chat, tasks) do not need to
// import each other. `useChat.receive` emits every frame; whoever cares subscribes (see
// `chatLifecycle.js`) and ignores the types it does not know.

const listeners = new Set()

/** Subscribe; returns the unsubscribe function. */
export function onFrame(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emitFrame(frame) {
  for (const fn of listeners) {
    try {
      fn(frame)
    } catch (err) {
      console.error('a frame listener failed', err) // one listener must not stop the others
    }
  }
}

// Which tasks exist for the person using this browser, so a message can link them (`#T-102`).
// The task store registers it; chat asks, and neither imports the other.
let taskIdsProvider = () => []

export function setTaskIdsProvider(fn) {
  taskIdsProvider = fn
}

/** The numbers of the tasks this person can see (`['T-101', …]`). */
export const taskIds = () => taskIdsProvider()

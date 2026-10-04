// A small event bus (SPEC_dopa §5.4, SD-D01): the reading loop says what happens, and a display
// that wants to show it listens. Synchronous, no queue. With no listener an event costs nothing,
// so 「いつもの」 is not changed by it.

// event name -> the functions listening to it
const listeners = new Map();

/** Call `listener(data)` at every event of this name. */
export function on(name, listener) {
  if (!listeners.has(name)) {
    listeners.set(name, []);
  }

  const list = listeners.get(name);
  list.push(listener);
}

/** Stop calling a listener. */
export function off(name, listener) {
  const list = listeners.get(name);

  if (list) {
    const others = list.filter((kept) => kept !== listener);
    listeners.set(name, others);
  }
}

/** Tell the listeners of an event. A listener that throws is named in the console; the caller
 * (the reading loop) and the other listeners go on. */
export function emit(name, data) {
  const list = listeners.get(name);
  if (!list) {
    return;
  }

  for (const listener of list) {
    try {
      listener(data);
    } catch (error) {
      let reason = error;
      if (error && error.stack) {
        reason = error.stack;
      }

      console.warn(`bus: a listener of "${name}" failed: ${reason}`);
    }
  }
}
